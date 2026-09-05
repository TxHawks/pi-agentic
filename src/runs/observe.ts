import type { JsonAgentSessionEvent, SessionHeader } from "@earendil-works/pi-coding-agent";
import type { Settings } from "../settings/loader.ts";
import { type LogCursor, readObservationLog } from "./log-read.ts";
import { ObservationReducer, type ObservedCallerPing } from "./observation-reducer.ts";

const SOFT_LOG_SIZE_BYTES = 70 * 1024 * 1024;

/**
 * One non-blocking reader of one observation log, with three outputs:
 *
 * - liveView: this read's raw Pi events, with all content intact. The human
 *   view can apply Pi's deltas and authoritative message_end snapshots.
 *   No full history is held here. A torn tail is a raw preview, not an event.
 * - peek: content-free progress facts, for UI and internal decisions only.
 *   Never send this projection into an agent's context.
 * - detectors: terminal evidence, retry facts, and this read's caller pings.
 *   Terminal evidence does not prove that the process ended or the run settled.
 *
 * Keep this reader for incremental reads. Its cursor and counts live only in
 * memory. A new reader starts in the bounded tail window. Counts and usage
 * cover only what it read; health.truncated stays true while history is missing.
 * health.restarted applies to this read only: discard the old human view then.
 * A restart also clears all reducer state. Neither read nor reduce writes files,
 * stops a child, declares an outcome, or sends a parent message.
 *
 * Pi does not timestamp every event. Ages use the log's modification time
 * when a batch contains a valid event, never the time of a cold read. They are
 * lower bounds when a batch also contains later writes. An active tool's age
 * starts with the batch that contains its start; an unseen start has no age.
 * These facts are not durable per-event timestamps for deadline enforcement.
 */
export function createObservation(path: string, settings: Settings, now = Date.now) {
	let cursor: LogCursor | null = null;
	let reducer = new ObservationReducer();
	let skippedLines = 0;
	let unknownEvents = 0;
	let truncated = false;
	return {
		read() {
			const nowMs = now();
			const read = readObservationLog(path, cursor);
			cursor = read.cursor;
			if (read.restarted) {
				reducer = new ObservationReducer();
				skippedLines = 0;
				unknownEvents = 0;
				truncated = false;
			}
			truncated ||= read.truncated;
			skippedLines += read.skippedLines;
			let header: SessionHeader | null = null;
			const events: JsonAgentSessionEvent[] = [];
			const callerPings: ObservedCallerPing[] = [];
			for (const event of read.events) {
				if (event.type === "session") {
					if (
						typeof event.id === "string" &&
						typeof event.timestamp === "string" &&
						typeof event.cwd === "string"
					)
						header = event as unknown as SessionHeader;
					else skippedLines += 1;
				} else {
					const parsed = event as unknown as JsonAgentSessionEvent;
					const ping = reducer.apply(parsed, Math.min(nowMs, read.modifiedAtMs ?? nowMs));
					if (ping === "malformed" || ping === "unknown") {
						skippedLines += 1;
						if (ping === "unknown") unknownEvents += 1;
					} else {
						if (ping) callerPings.push(ping);
						events.push(parsed);
					}
				}
			}
			return {
				liveView: { header, events, tornTail: read.tornTail },
				peek: {
					...reducer.peek(nowMs),
					health: {
						skippedLines,
						unknownEvents,
						tornTail: read.tornTail !== null,
						restarted: read.restarted,
						truncated,
						logSizeBytes: read.sizeBytes,
						logLarge: read.sizeBytes >= SOFT_LOG_SIZE_BYTES,
						logCeiling: read.sizeBytes >= settings.retention.maxLogSizeBytes,
					},
				},
				detectors: reducer.detectors(nowMs, callerPings),
			};
		},
	};
}
