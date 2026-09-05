/**
 * The read layer over the observation log: in-memory cursors and bounded
 * reads. A cursor is a byte offset at a line boundary plus a short head
 * fingerprint of the file. Cursors live in memory, per reader, and are
 * never written to disk. Every read returns at once with whatever exists,
 * reads at most the poll read cap, and never re-reads a whole log:
 *
 * - A read without a cursor is a cold read. It starts inside the tail
 *   window and flags `truncated` when earlier bytes were left unread.
 * - A replaced or shrunk file fails the fingerprint check; the read
 *   restarts from the tail window and flags `restarted`.
 * - A torn last line at the end of the file is returned separately, and
 *   the cursor never moves past it, so the next read completes it.
 * - A line that cannot be an event (not JSON, not an object, no type)
 *   is skipped and counted, never fatal.
 */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** The most bytes one read takes from the log. */
export const POLL_READ_CAP_BYTES = 1024 * 1024;

/** How far back into the file a cold read starts. */
export const COLD_READ_TAIL_WINDOW_BYTES = 256 * 1024;

/** How many head bytes the fingerprint covers, at most. */
const HEAD_FINGERPRINT_WINDOW_BYTES = 4096;

const NEWLINE = 0x0a;

/** The hash of the first `length` bytes of the file, at cursor time. */
interface HeadFingerprint {
	length: number;
	hash: string;
}

/**
 * Where the next read continues. Opaque to callers: hold it in memory,
 * pass it back to the next read, and never persist or build one.
 */
export interface LogCursor {
	/** Byte offset at a line boundary (or inside a line being skipped). */
	offset: number;
	fingerprint: HeadFingerprint;
	/** The reader is inside a line it cannot parse whole; bytes up to the next newline are discarded. */
	skipToNextLine: boolean;
}

/** One parsed log line: a JSON object with a type. The reducer decides what it means. */
type RawLogEvent = { type: string } & Record<string, unknown>;

export interface LogReadResult {
	events: RawLogEvent[];
	/** The torn last line of the file, raw. Show it as a preview at most; the next read completes it. */
	tornTail: string | null;
	/** Lines in this read that cannot be an event: not JSON, not an object, or no type. */
	skippedLines: number;
	/** This read started inside the file, so earlier bytes were never read. */
	truncated: boolean;
	/** The file was replaced or shrunk; this read restarted from the tail window. */
	restarted: boolean;
	cursor: LogCursor;
}

/** Read the observation log once, without blocking. No cursor means a cold read. */
export function readObservationLog(path: string, cursor: LogCursor | null = null): LogReadResult {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return emptyResult(
			cursor ?? { offset: 0, fingerprint: hashHead(Buffer.alloc(0)), skipToNextLine: false },
		);
	}
	try {
		return readOpenLog(fd, cursor);
	} finally {
		closeSync(fd);
	}
}

function readOpenLog(fd: number, cursor: LogCursor | null): LogReadResult {
	const size = fstatSync(fd).size;
	const head = readChunk(fd, 0, Math.min(size, HEAD_FINGERPRINT_WINDOW_BYTES));
	const fingerprint = hashHead(head);

	let restarted = false;
	let start: number;
	let skipToNextLine: boolean;
	if (cursor !== null && cursor.offset <= size && headMatches(head, cursor.fingerprint)) {
		start = cursor.offset;
		skipToNextLine = cursor.skipToNextLine;
	} else {
		restarted = cursor !== null;
		start = Math.max(0, size - COLD_READ_TAIL_WINDOW_BYTES);
		// The window start cannot know line boundaries, so the first line in
		// the window is always dropped; `truncated` reports the loss.
		skipToNextLine = start > 0;
	}
	const truncated = cursor === null || restarted ? start > 0 : false;

	const chunk = readChunk(fd, start, Math.min(size - start, POLL_READ_CAP_BYTES));
	const atEndOfFile = start + chunk.length >= size;

	let parseFrom = 0;
	if (skipToNextLine) {
		const firstNewline = chunk.indexOf(NEWLINE);
		if (firstNewline === -1) {
			return {
				...emptyResult({ offset: start + chunk.length, fingerprint, skipToNextLine: true }),
				truncated,
				restarted,
			};
		}
		parseFrom = firstNewline + 1;
	}

	const lastNewline = chunk.lastIndexOf(NEWLINE);
	if (lastNewline < parseFrom) {
		// No whole line in this chunk past parseFrom.
		if (atEndOfFile) {
			const tail = chunk.subarray(parseFrom);
			return {
				events: [],
				tornTail: tail.length > 0 ? tail.toString("utf8") : null,
				skippedLines: 0,
				truncated,
				restarted,
				cursor: { offset: start + parseFrom, fingerprint, skipToNextLine: false },
			};
		}
		if (parseFrom > 0) {
			// The line continues past the cap, but this read made progress:
			// the next read starts at the line's own start with a full cap.
			return {
				...emptyResult({ offset: start + parseFrom, fingerprint, skipToNextLine: false }),
				truncated,
				restarted,
			};
		}
		// One line is longer than the read cap — including a torn tail that
		// grew past the cap. The bounded-read rule wins over the torn-tail
		// rule: count the line once, then discard its bytes until its
		// newline passes by.
		return {
			...emptyResult({ offset: start + chunk.length, fingerprint, skipToNextLine: true }),
			skippedLines: 1,
			truncated,
			restarted,
		};
	}

	const { events, skippedLines } = parseLines(chunk.subarray(parseFrom, lastNewline));
	const rest = chunk.subarray(lastNewline + 1);
	const tornTail = atEndOfFile && rest.length > 0 ? rest.toString("utf8") : null;
	return {
		events,
		tornTail,
		skippedLines,
		truncated,
		restarted,
		cursor: { offset: start + lastNewline + 1, fingerprint, skipToNextLine: false },
	};
}

function parseLines(region: Buffer): { events: RawLogEvent[]; skippedLines: number } {
	const events: RawLogEvent[] = [];
	let skippedLines = 0;
	for (const line of region.toString("utf8").split("\n")) {
		if (line.length === 0) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			skippedLines += 1;
			continue;
		}
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			typeof (value as { type?: unknown }).type !== "string"
		) {
			skippedLines += 1;
			continue;
		}
		events.push(value as RawLogEvent);
	}
	return { events, skippedLines };
}

function readChunk(fd: number, position: number, length: number): Buffer {
	const buffer = Buffer.alloc(Math.max(0, length));
	let read = 0;
	while (read < buffer.length) {
		const got = readSync(fd, buffer, read, buffer.length - read, position + read);
		if (got === 0) return buffer.subarray(0, read);
		read += got;
	}
	return buffer;
}

function hashHead(head: Buffer): HeadFingerprint {
	return { length: head.length, hash: createHash("sha256").update(head).digest("hex") };
}

function headMatches(head: Buffer, fingerprint: HeadFingerprint): boolean {
	if (head.length < fingerprint.length) return false;
	const prefix = hashHead(head.subarray(0, fingerprint.length));
	return prefix.hash === fingerprint.hash;
}

function emptyResult(cursor: LogCursor): LogReadResult {
	return {
		events: [],
		tornTail: null,
		skippedLines: 0,
		truncated: false,
		restarted: false,
		cursor,
	};
}
