// The read layer over the observation log (#42): in-memory cursors at line
// boundaries, bounded reads, torn-tail handling, the cold-read tail window,
// and replaced/shrunk-file detection. Every test writes a real temp file and
// asserts on the public read result only.
import { appendFileSync } from "node:fs";
import {
	COLD_READ_TAIL_WINDOW_BYTES,
	POLL_READ_CAP_BYTES,
	readObservationLog,
} from "../../src/runs/log-read.ts";
import {
	after,
	assert,
	before,
	createTestDir,
	describe,
	it,
	join,
	piEventFixturesDir,
	readFileSync,
	rmSync,
	writeFileSync,
} from "../support/index.ts";

function eventLine(type: string, extra: Record<string, unknown> = {}): string {
	return `${JSON.stringify({ type, ...extra })}\n`;
}

/** An event line padded to exactly `bytes` bytes, newline included. */
function paddedLine(index: number, bytes: number): string {
	const bare = eventLine("message_update", { index, pad: "" });
	return eventLine("message_update", { index, pad: "x".repeat(bytes - bare.length) });
}

describe("observation log reads", () => {
	let dir: string;
	let fileCount = 0;

	before(() => {
		dir = createTestDir();
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function freshLog(content: string | null): string {
		fileCount += 1;
		const path = join(dir, `observation-${fileCount}.log`);
		if (content !== null) writeFileSync(path, content);
		return path;
	}

	it("returns every whole line as an event, at once", () => {
		const path = freshLog(eventLine("agent_start") + eventLine("turn_start"));

		const read = readObservationLog(path);

		assert.deepEqual(
			read.events.map((event) => event.type),
			["agent_start", "turn_start"],
		);
		assert.equal(read.tornTail, null);
		assert.equal(read.skippedLines, 0);
		assert.equal(read.truncated, false);
		assert.equal(read.restarted, false);
	});

	it("continues from the cursor and never re-reads delivered lines", () => {
		const path = freshLog(eventLine("agent_start"));
		const first = readObservationLog(path);
		appendFileSync(path, eventLine("turn_start") + eventLine("turn_end"));

		const second = readObservationLog(path, first.cursor);

		assert.deepEqual(
			second.events.map((event) => event.type),
			["turn_start", "turn_end"],
		);
	});

	it("answers empty when nothing new exists", () => {
		const path = freshLog(eventLine("agent_start"));
		const first = readObservationLog(path);

		const second = readObservationLog(path, first.cursor);

		assert.deepEqual(second.events, []);
		assert.equal(second.tornTail, null);
	});

	it("returns a torn last line separately, and the next read completes it", () => {
		const torn = '{"type":"message_end","message":{"ro';
		const path = freshLog(eventLine("agent_start") + torn);

		const first = readObservationLog(path);
		assert.deepEqual(
			first.events.map((event) => event.type),
			["agent_start"],
		);
		assert.equal(first.tornTail, torn);
		assert.equal(first.skippedLines, 0);

		appendFileSync(path, 'le":"assistant"}}\n');
		const second = readObservationLog(path, first.cursor);
		assert.deepEqual(
			second.events.map((event) => event.type),
			["message_end"],
		);
		assert.equal(second.tornTail, null);
	});

	it("cold-reads a large log from the tail window and flags truncation", () => {
		const lineBytes = 1024;
		const lineCount = COLD_READ_TAIL_WINDOW_BYTES / lineBytes + 44;
		let content = "";
		for (let index = 0; index < lineCount; index++) content += paddedLine(index, lineBytes);
		const path = freshLog(content);

		const read = readObservationLog(path);

		assert.equal(read.truncated, true);
		assert.equal(read.restarted, false);
		// The window starts inside the file; the first (possibly partial) line
		// in the window is dropped, and every later line arrives whole.
		assert.equal(read.events.length, COLD_READ_TAIL_WINDOW_BYTES / lineBytes - 1);
		assert.equal(read.events[read.events.length - 1]?.index, lineCount - 1);
		assert.equal(read.skippedLines, 0);

		appendFileSync(path, eventLine("agent_settled"));
		const next = readObservationLog(path, read.cursor);
		assert.deepEqual(
			next.events.map((event) => event.type),
			["agent_settled"],
		);
		assert.equal(next.truncated, false);
	});

	it("cold-reads a small log from the start without a truncation flag", () => {
		const path = freshLog(eventLine("agent_start") + eventLine("agent_settled"));

		const read = readObservationLog(path);

		assert.equal(read.truncated, false);
		assert.equal(read.events.length, 2);
	});

	it("detects a replaced file through the fingerprint and restarts", () => {
		const path = freshLog(eventLine("session", { id: "first" }) + eventLine("agent_start"));
		const first = readObservationLog(path);

		writeFileSync(path, eventLine("session", { id: "second" }) + eventLine("turn_start"));
		const second = readObservationLog(path, first.cursor);

		assert.equal(second.restarted, true);
		assert.deepEqual(
			second.events.map((event) => event.type),
			["session", "turn_start"],
		);
		assert.equal(second.truncated, false);

		appendFileSync(path, eventLine("agent_settled"));
		const third = readObservationLog(path, second.cursor);
		assert.equal(third.restarted, false);
		assert.deepEqual(
			third.events.map((event) => event.type),
			["agent_settled"],
		);
	});

	it("detects a shrunk file whose head stayed intact and restarts", () => {
		const lineBytes = 1024;
		let content = "";
		for (let index = 0; index < 8; index++) content += paddedLine(index, lineBytes);
		const path = freshLog(content);
		const first = readObservationLog(path);
		assert.equal(first.events.length, 8);

		writeFileSync(path, content.slice(0, 6 * lineBytes));
		const second = readObservationLog(path, first.cursor);

		assert.equal(second.restarted, true);
		assert.equal(second.events.length, 6);
	});

	it("returns empty for a log that does not exist yet, then reads it from the start", () => {
		const path = freshLog(null);

		const first = readObservationLog(path);
		assert.deepEqual(first.events, []);
		assert.equal(first.tornTail, null);

		writeFileSync(path, eventLine("agent_start"));
		const second = readObservationLog(path, first.cursor);
		assert.deepEqual(
			second.events.map((event) => event.type),
			["agent_start"],
		);
		assert.equal(second.truncated, false);
	});

	it("skips and counts the broken lines of the malformed-lines fixture", () => {
		const path = freshLog(
			readFileSync(join(piEventFixturesDir, "synthetic-malformed-lines.jsonl"), "utf8"),
		);

		const read = readObservationLog(path);

		// The fixture carries one line that is not JSON and one JSON line that
		// is not an object. Both are skipped and counted, never fatal.
		assert.equal(read.skippedLines, 2);
		assert.equal(read.tornTail, null);
		// An unknown event type passes through raw; the reducer judges it later.
		assert.ok(read.events.some((event) => event.type === "fixture_unknown_event"));
		assert.ok(read.events.some((event) => event.type === "message_end"));
		assert.ok(read.events.some((event) => event.type === "agent_settled"));
	});

	it("reads the torn-tail fixture: whole lines as events, the torn line separately", () => {
		const raw = readFileSync(join(piEventFixturesDir, "synthetic-torn-tail.jsonl"), "utf8");
		const path = freshLog(raw);
		const lines = raw.split("\n");

		const read = readObservationLog(path);

		assert.equal(read.events.length, lines.length - 1);
		assert.equal(read.tornTail, lines[lines.length - 1]);
		assert.equal(read.skippedLines, 0);
	});

	it("bounds one read by the read cap and loses nothing across reads", () => {
		const path = freshLog("");
		const attached = readObservationLog(path);

		const lineBytes = 1000;
		const lineCount = 1600;
		let content = "";
		for (let index = 0; index < lineCount; index++) content += paddedLine(index, lineBytes);
		appendFileSync(path, content);

		const first = readObservationLog(path, attached.cursor);
		assert.equal(first.events.length, Math.floor(POLL_READ_CAP_BYTES / lineBytes));
		// The cap cut inside a line that the file completes: that line is not
		// a torn tail, and the next read returns it whole.
		assert.equal(first.tornTail, null);
		assert.equal(first.truncated, false);

		const second = readObservationLog(path, first.cursor);
		assert.equal(first.events.length + second.events.length, lineCount);
		const indexes = [...first.events, ...second.events].map((event) => event.index);
		assert.deepEqual(
			indexes,
			Array.from({ length: lineCount }, (_, index) => index),
		);
	});

	it("skips and counts a single line longer than the read cap", () => {
		const path = freshLog("");
		const attached = readObservationLog(path);
		appendFileSync(
			path,
			paddedLine(0, POLL_READ_CAP_BYTES + 200 * 1024) + eventLine("agent_settled"),
		);

		const first = readObservationLog(path, attached.cursor);
		assert.deepEqual(first.events, []);
		assert.equal(first.skippedLines, 1);
		assert.equal(first.tornTail, null);

		const second = readObservationLog(path, first.cursor);
		assert.deepEqual(
			second.events.map((event) => event.type),
			["agent_settled"],
		);
		assert.equal(second.skippedLines, 0);
	});
});
