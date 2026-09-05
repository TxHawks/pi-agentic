// Guard for the committed Pi event fixtures in test/fixtures/pi-events/.
//
// The recorded fixtures are raw `pi -p --mode json` stdout streams that
// scripts/record-pi-event-fixtures.mjs regenerates. The synthetic fixtures are
// hand-built broken streams that recording cannot produce. This suite proves
// the committed set covers the event shapes the code that reads observation
// logs consumes: assistant text, thinking, tool calls and results, errors,
// token usage, and completion — and that each recorded fixture states its Pi
// version.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { piEventFixturesDir as fixturesDir } from "../support/index.ts";

const RECORDED_FIXTURES = ["assistant-text", "thinking", "tool-calls", "provider-error"] as const;
const SYNTHETIC_FIXTURES = ["synthetic-torn-tail", "synthetic-malformed-lines"] as const;

type JsonObject = Record<string, unknown>;

function readLines(name: string): string[] {
	const path = join(fixturesDir, `${name}.jsonl`);
	assert.ok(existsSync(path), `missing fixture stream: ${path}`);
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.length > 0);
}

function readMeta(name: string): JsonObject {
	const path = join(fixturesDir, `${name}.meta.json`);
	assert.ok(existsSync(path), `missing fixture meta: ${path}`);
	return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}

function parseObject(line: string): JsonObject | null {
	try {
		const value = JSON.parse(line) as unknown;
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			return value as JsonObject;
		}
		return null;
	} catch {
		return null;
	}
}

function parseEvents(name: string): JsonObject[] {
	return readLines(name).map((line, index) => {
		const event = parseObject(line);
		assert.ok(event, `${name}.jsonl line ${index + 1} must parse as a JSON object`);
		return event;
	});
}

function deltaType(event: JsonObject): string | undefined {
	if (event.type !== "message_update") return undefined;
	const inner = event.assistantMessageEvent as JsonObject | undefined;
	return typeof inner?.type === "string" ? inner.type : undefined;
}

function messageOf(event: JsonObject): JsonObject | undefined {
	return typeof event.message === "object" && event.message !== null
		? (event.message as JsonObject)
		: undefined;
}

test("every recorded fixture states the Pi version it came from", () => {
	for (const name of RECORDED_FIXTURES) {
		const meta = readMeta(name);
		assert.equal(meta.scenario, name, `${name} meta must name its scenario`);
		assert.equal(meta.source, "recorded", `${name} meta must state source "recorded"`);
		assert.match(
			String(meta.piVersion),
			/^\d+\.\d+\.\d+/,
			`${name} meta must state the Pi version it came from`,
		);
		assert.ok(
			typeof meta.model === "string" && meta.model.length > 0,
			`${name} meta must state the model ref it was recorded with`,
		);
		assert.ok(
			!Number.isNaN(Date.parse(String(meta.recordedAt))),
			`${name} meta must state a valid recording time`,
		);
	}
});

test("every synthetic fixture states that it is hand-built", () => {
	for (const name of SYNTHETIC_FIXTURES) {
		const meta = readMeta(name);
		assert.equal(meta.scenario, name, `${name} meta must name its scenario`);
		assert.equal(meta.source, "synthetic", `${name} meta must state source "synthetic"`);
	}
});

test("every recorded stream is well-formed and carries completion evidence", () => {
	for (const name of RECORDED_FIXTURES) {
		const events = parseEvents(name);
		assert.equal(events[0]?.type, "session", `${name} must start with the session header`);
		assert.ok(
			events.some((e) => e.type === "agent_end"),
			`${name} must carry an agent_end event`,
		);
		assert.ok(
			events.some((e) => e.type === "agent_settled"),
			`${name} must carry an agent_settled event`,
		);
	}
});

test("the assistant-text fixture covers assistant text and token usage", () => {
	const events = parseEvents("assistant-text");
	assert.ok(
		events.some((e) => deltaType(e) === "text_delta"),
		"assistant-text must carry a text_delta message_update",
	);
	assert.ok(
		events.some((e) => {
			if (e.type !== "message_end") return false;
			const message = messageOf(e);
			if (message?.role !== "assistant") return false;
			const usage = message.usage as JsonObject | undefined;
			return typeof usage?.input === "number" && typeof usage?.output === "number";
		}),
		"assistant-text must carry an assistant message_end with token usage",
	);
});

test("the thinking fixture covers thinking deltas", () => {
	const events = parseEvents("thinking");
	assert.ok(
		events.some((e) => deltaType(e) === "thinking_delta"),
		"thinking must carry a thinking_delta message_update",
	);
});

test("the tool-calls fixture covers tool calls and tool results", () => {
	const events = parseEvents("tool-calls");
	assert.ok(
		events.some((e) => deltaType(e) === "toolcall_start"),
		"tool-calls must carry a toolcall_start message_update",
	);
	assert.ok(
		events.some((e) => e.type === "tool_execution_start"),
		"tool-calls must carry a tool_execution_start event",
	);
	assert.ok(
		events.some((e) => e.type === "tool_execution_end"),
		"tool-calls must carry a tool_execution_end event with the tool result",
	);
});

test("the provider-error fixture covers retry and error evidence", () => {
	const events = parseEvents("provider-error");
	assert.ok(
		events.some((e) => e.type === "auto_retry_start"),
		"provider-error must carry an auto_retry_start event",
	);
	assert.ok(
		events.some((e) => e.type === "auto_retry_end" && e.success === false),
		"provider-error must carry a failed auto_retry_end event",
	);
	assert.ok(
		events.some((e) => e.type === "message_end" && messageOf(e)?.stopReason === "error"),
		"provider-error must carry a message_end with stopReason error",
	);
});

test("the torn-tail fixture ends with one torn line", () => {
	const path = join(fixturesDir, "synthetic-torn-tail.jsonl");
	assert.ok(existsSync(path), `missing fixture stream: ${path}`);
	const raw = readFileSync(path, "utf8");
	assert.ok(!raw.endsWith("\n"), "the torn-tail stream must not end with a newline");
	const lines = raw.split("\n");
	assert.ok(lines.length > 1, "the torn-tail stream needs whole lines before the torn line");
	for (const [index, line] of lines.slice(0, -1).entries()) {
		assert.ok(parseObject(line), `torn-tail line ${index + 1} must parse as a JSON object`);
	}
	assert.equal(
		parseObject(lines[lines.length - 1]),
		null,
		"the last torn-tail line must not parse",
	);
});

test("the malformed-lines fixture mixes good lines with broken lines", () => {
	const raw = readFileSync(join(fixturesDir, "synthetic-malformed-lines.jsonl"), "utf8");
	assert.ok(raw.endsWith("\n"), "the malformed-lines stream must end with a whole line");
	const lines = raw.split("\n").filter((line) => line.length > 0);
	const parsed = lines.map(parseObject);
	assert.ok(
		lines.some((line) => {
			try {
				JSON.parse(line);
				return false;
			} catch {
				return true;
			}
		}),
		"the stream must carry a line that is not JSON",
	);
	assert.ok(
		lines.some((line) => {
			try {
				return parseObject(line) === null && JSON.parse(line) !== undefined;
			} catch {
				return false;
			}
		}),
		"the stream must carry a JSON line that is not an object",
	);
	assert.ok(
		parsed.some((event) => event?.type === "fixture_unknown_event"),
		"the stream must carry an event with an unknown type",
	);
	assert.ok(
		parsed.some((event) => event?.type === "message_end"),
		"the stream must keep good event lines between the broken lines",
	);
});
