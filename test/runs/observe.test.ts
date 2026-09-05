import assert from "node:assert/strict";
import {
	appendFileSync,
	readFileSync,
	rmSync,
	truncateSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createObservation } from "../../src/runs/observe.ts";
import { defaultSettings } from "../../src/settings/loader.ts";
import { FakeClock } from "../support/fake-clock.ts";
import { createTestDir, piEventFixturesDir } from "../support/fixtures.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function log(content = "") {
	const dir = createTestDir();
	dirs.push(dir);
	const path = join(dir, "observation.log");
	const clock = new FakeClock(1_000_000);
	const settings = defaultSettings();
	writeFileSync(path, content);
	function stamp() {
		utimesSync(path, clock.now() / 1000, clock.now() / 1000);
	}
	stamp();
	return {
		path,
		clock,
		settings,
		observation: createObservation(path, settings, () => clock.now()),
		append(content: string) {
			appendFileSync(path, content);
			stamp();
		},
		replace(content: string) {
			writeFileSync(path, content);
			stamp();
		},
	};
}

function fixture(name: string): string {
	return readFileSync(join(piEventFixturesDir, `${name}.jsonl`), "utf8");
}

function lines(...events: object[]): string {
	return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

test("the live view keeps recorded text, thinking, tool activity, results, errors, and usage", () => {
	for (const name of ["assistant-text", "thinking", "tool-calls", "provider-error"]) {
		const raw = fixture(name);
		const { observation } = log(raw);
		const result = observation.read();
		// The recording is the source of truth. No content field may be removed
		// from the human view, including fields added by a provider.
		const [header, ...events] = raw
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.deepEqual(result.liveView, { header, events, tornTail: null });
	}
});

test("peek counts completed work and usage once, without copying message content", () => {
	const { observation, append, clock } = log(fixture("tool-calls"));
	const first = observation.read();
	assert.equal(first.peek.eventCount, 40);
	assert.equal(first.peek.turnCount, 2);
	assert.equal(first.peek.messageCount, 4);
	assert.deepEqual(first.peek.tools, {
		started: 1,
		completed: 1,
		failed: 0,
		names: ["bash"],
		active: [],
	});
	assert.deepEqual(first.peek.usage, {
		input: 7675,
		output: 149,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 7824,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
	assert.equal(first.peek.latestAssistantUsage?.totalTokens, 3948);
	clock.advance(2000);
	const second = observation.read();
	assert.deepEqual(second.liveView.events, []);
	assert.equal(second.peek.eventCount, 40);
	assert.deepEqual(second.peek.usage, first.peek.usage);
	append(
		lines({
			type: "tool_execution_start",
			toolCallId: "private-id",
			toolName: "read",
			args: { path: "private-path" },
		}),
	);
	const third = observation.read();
	assert.equal(third.peek.eventCount, 41);
	assert.deepEqual(third.peek.tools, {
		started: 2,
		completed: 1,
		failed: 0,
		names: ["bash", "read"],
		active: [{ name: "read", elapsedMs: 0 }],
	});
	assert.ok(!JSON.stringify(third.peek).includes("private"));
	// Returned facts are snapshots, not references into the next read's state.
	assert.deepEqual(first.peek.tools.names, ["bash"]);
});

test("detectors report retry and terminal evidence, then detect each caller ping once", () => {
	const brokenProvider = fixture("provider-error").trim().split("\n");
	const { observation, append, clock } = log(`${brokenProvider.slice(0, -2).join("\n")}\n`);
	const retrying = observation.read();
	assert.deepEqual(retrying.detectors.settle, {
		agentSettled: false,
		agentEndWillRetry: false,
		lastStopReason: "error",
	});
	assert.deepEqual(retrying.detectors.retry, {
		active: true,
		starts: 2,
		attempt: 2,
		maxAttempts: 2,
		delayMs: 500,
		success: null,
	});
	assert.equal(retrying.peek.assistantErrors, 3);
	clock.advance(250);
	append(`${brokenProvider.slice(-2).join("\n")}\n`);
	const ended = observation.read();
	assert.equal(ended.detectors.settle.agentSettled, true);
	assert.equal(ended.detectors.retry.active, false);
	assert.equal(ended.detectors.retry.success, false);
	assert.equal(ended.detectors.lastEventAgeMs, 0);
	clock.advance(5000);
	assert.equal(observation.read().detectors.lastEventAgeMs, 5000);
	append(
		lines(
			{ type: "agent_start" },
			{
				type: "tool_execution_start",
				toolName: "caller_ping",
				toolCallId: "ping-1",
				args: { message: "private help request" },
			},
		),
	);
	const ping = observation.read();
	assert.deepEqual(ping.detectors.callerPings, [
		{ toolCallId: "ping-1", message: "private help request" },
	]);
	assert.equal(ping.detectors.settle.agentSettled, false);
	assert.equal(ping.detectors.settle.agentEndWillRetry, null);
	assert.ok(!JSON.stringify(ping.peek).includes("private"));
	assert.deepEqual(observation.read().detectors.callerPings, []);
});

test("broken lines and unknown events are skipped once, while later valid events still work", () => {
	const { observation, append } = log(fixture("synthetic-malformed-lines"));
	const first = observation.read();
	assert.equal(first.peek.health.skippedLines, 3);
	assert.equal(first.peek.health.unknownEvents, 1);
	assert.equal(first.peek.eventCount, 7);
	assert.equal(first.detectors.settle.agentSettled, true);
	assert.equal(first.peek.usage.totalTokens, 3033);
	append(
		lines(
			{ type: "message_end" },
			{ type: "message_end", message: { role: "assistant", content: null } },
			{
				type: "tool_execution_start",
				toolName: { private: "content" },
				toolCallId: "bad",
				args: {},
			},
			{
				type: "auto_retry_start",
				attempt: "bad",
				maxAttempts: 2,
				delayMs: 5,
				errorMessage: "private",
			},
			{
				type: "message_update",
				usage: first.peek.usage,
				assistantMessageEvent: { type: "future_delta", delta: "private" },
			},
			{ type: "agent_end", messages: [], willRetry: "not a boolean" },
			{ type: "turn_start" },
		),
	);
	const second = observation.read();
	assert.deepEqual(second.liveView.events, [{ type: "turn_start" }]);
	assert.equal(second.peek.health.skippedLines, 9);
	assert.equal(second.peek.health.unknownEvents, 2);
	assert.equal(second.peek.eventCount, 8);
	assert.ok(!JSON.stringify(second.peek).includes("private"));
	assert.deepEqual(observation.read().peek.health, second.peek.health);
});

test("a torn tail is human-only, and completes once without adding broken-event counts", () => {
	const raw = fixture("synthetic-torn-tail");
	const { observation, append } = log(raw);
	const first = observation.read();
	assert.equal(first.peek.health.tornTail, true);
	assert.equal(first.liveView.tornTail, raw.slice(raw.lastIndexOf("\n") + 1));
	assert.equal(first.peek.health.skippedLines, 0);
	assert.equal(first.peek.eventCount, 4);
	assert.equal(first.detectors.settle.agentSettled, false);
	append(
		'cacheWrite":0,"total":0}},"assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"private tail"}}\n',
	);
	const completed = observation.read();
	assert.equal(completed.liveView.events.length, 1);
	assert.equal(completed.peek.health.tornTail, false);
	assert.equal(completed.peek.eventCount, 5);
	assert.equal(completed.peek.health.skippedLines, 0);
	assert.ok(!JSON.stringify(completed.peek).includes("private tail"));
	assert.deepEqual(observation.read().liveView.events, []);
});

test("a replaced log clears old counts, usage, terminal evidence, and active tools", () => {
	const { observation, replace } = log(fixture("tool-calls"));
	observation.read();
	replace(lines({ type: "turn_start" }));
	const result = observation.read();
	assert.equal(result.peek.health.restarted, true);
	assert.equal(result.peek.eventCount, 1);
	assert.equal(result.peek.usage.totalTokens, 0);
	assert.equal(result.peek.latestAssistantUsage, null);
	assert.deepEqual(result.peek.tools, {
		started: 0,
		completed: 0,
		failed: 0,
		names: [],
		active: [],
	});
	assert.deepEqual(result.detectors.settle, {
		agentSettled: false,
		agentEndWillRetry: null,
		lastStopReason: null,
	});
	assert.equal(observation.read().peek.health.restarted, false);
});

test("a cold read flags unread history and does not make an old log look fresh", () => {
	const old = lines({
		type: "tool_execution_start",
		toolCallId: "old",
		toolName: "bash",
		args: { private: "old" },
	});
	const { observation, clock, append, replace } = log(
		old + "\n".repeat(300 * 1024) + lines({ type: "turn_start" }),
	);
	clock.advance(12_000);
	const first = observation.read();
	assert.equal(first.peek.health.truncated, true);
	assert.equal(first.peek.eventCount, 1);
	assert.deepEqual(first.peek.tools.names, []);
	assert.equal(first.detectors.lastEventAgeMs, 12_000);
	assert.equal(first.peek.lastEventAgeMs, 12_000);
	assert.equal(observation.read().peek.health.truncated, true);
	append("bad line\n");
	clock.advance(500);
	assert.equal(observation.read().detectors.lastEventAgeMs, 12_500);
	replace(lines({ type: "agent_start" }));
	assert.equal(observation.read().peek.health.truncated, false);
});

test("peek flags the fixed soft log size and the settings-based hard ceiling", () => {
	const { path, settings, observation } = log();
	settings.retention.maxLogSizeBytes = 80 * 1024 * 1024;
	for (const [bytes, logLarge, logCeiling] of [
		[70 * 1024 * 1024 - 1, false, false],
		[70 * 1024 * 1024, true, false],
		[80 * 1024 * 1024 - 1, true, false],
		[80 * 1024 * 1024, true, true],
	] as const) {
		// Sparse files exercise the real file size without allocating 80 MiB.
		truncateSync(path, bytes);
		const { health } = observation.read().peek;
		assert.equal(health.logSizeBytes, bytes);
		assert.equal(health.logLarge, logLarge);
		assert.equal(health.logCeiling, logCeiling);
	}
});

test("streaming usage replaces the current estimate; only completed messages enter totals", () => {
	const finalLine = fixture("assistant-text")
		.trim()
		.split("\n")
		.find((line) => line.includes('"type":"message_end","message":{"role":"assistant"'));
	assert.ok(finalLine);
	const final = JSON.parse(finalLine);
	// Extra data is legal in a raw provider event, but is not a progress fact.
	final.message.usage.private = "private usage field";
	final.message.usage.cost.private = "private cost field";
	const { observation, append } = log(
		lines({
			type: "message_update",
			usage: { ...final.message.usage, output: 1, totalTokens: 2980 },
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "private text" },
		}),
	);
	const partial = observation.read();
	assert.equal(partial.peek.streamingUsage?.totalTokens, 2980);
	assert.equal(partial.peek.usage.totalTokens, 0);
	assert.ok(!JSON.stringify(partial.peek).includes("private"));
	append(lines(final));
	const completed = observation.read();
	assert.equal(completed.peek.streamingUsage, null);
	assert.equal(completed.peek.usage.totalTokens, 3033);
	assert.equal(completed.peek.latestAssistantUsage?.totalTokens, 3033);
	assert.ok(!JSON.stringify(completed.peek).includes("private"));
	assert.ok(JSON.stringify(completed.liveView).includes("private usage field"));
	// Changing a returned event must not change a later progress snapshot.
	const end = completed.liveView.events[0];
	assert.ok(end.type === "message_end" && end.message.role === "assistant");
	end.message.usage.totalTokens = 999999;
	assert.equal(observation.read().peek.latestAssistantUsage?.totalTokens, 3033);
});

test("compaction, summary retries, queues, and session events keep content in the live view only", () => {
	const { observation, append } = log(
		lines(
			{ type: "queue_update", steering: ["private steering"], followUp: ["private follow-up"] },
			{ type: "compaction_start", reason: "overflow" },
			{
				type: "summarization_retry_scheduled",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 200,
				errorMessage: "private summary error",
			},
			{ type: "summarization_retry_attempt_start", source: "compaction", reason: "overflow" },
			{ type: "session_info_changed", name: "private session title" },
			{ type: "thinking_level_changed", level: "high" },
			{ type: "bash_execution_update", delta: "private shell output" },
		),
	);
	const active = observation.read();
	assert.equal(active.peek.health.skippedLines, 0);
	assert.deepEqual(active.peek.queue, { steering: 1, followUp: 1 });
	assert.deepEqual(active.peek.compaction, {
		active: true,
		starts: 1,
		reason: "overflow",
		aborted: null,
		willRetry: null,
		errors: 0,
	});
	assert.equal(active.peek.summarizationRetry.active, true);
	assert.equal(active.peek.summarizationRetry.starts, 1);
	assert.ok(!JSON.stringify(active.peek).includes("private"));
	const usage = {
		input: 20,
		output: 5,
		cacheRead: 10,
		cacheWrite: 0,
		totalTokens: 35,
		reasoning: 2,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
	};
	append(
		lines(
			{
				type: "entry_appended",
				entry: {
					type: "compaction",
					id: "entry",
					parentId: null,
					timestamp: "2026-01-01T00:00:00Z",
					summary: "private summary",
					firstKeptEntryId: "kept",
					tokensBefore: 5000,
					usage,
				},
			},
			{
				type: "compaction_end",
				reason: "overflow",
				aborted: false,
				willRetry: true,
				result: { summary: "private summary", firstKeptEntryId: "kept", tokensBefore: 5000, usage },
			},
			{ type: "summarization_retry_finished" },
		),
	);
	const done = observation.read();
	assert.equal(done.peek.compaction.active, false);
	assert.equal(done.peek.compaction.willRetry, true);
	assert.equal(done.peek.summarizationRetry.active, false);
	assert.deepEqual(done.peek.usage, usage);
	assert.equal(done.peek.eventCount, 10);
	assert.equal(done.peek.health.skippedLines, 0);
	assert.ok(!JSON.stringify(done.peek).includes("private"));
	assert.ok(JSON.stringify(done.liveView).includes("private summary"));
});

test("active tools keep their start time through updates and end independently", () => {
	const { observation, clock, append } = log();
	observation.read();
	append(
		lines({
			type: "tool_execution_start",
			toolCallId: "one",
			toolName: "read",
			args: { path: "private-path" },
		}),
	);
	observation.read();
	clock.advance(2000);
	append(
		lines(
			{
				type: "tool_execution_start",
				toolCallId: "two",
				toolName: "bash",
				args: { command: "private-command" },
			},
			{
				type: "tool_execution_update",
				toolCallId: "one",
				toolName: "read",
				args: { path: "private-path" },
				partialResult: { content: [{ type: "text", text: "private partial result" }] },
			},
		),
	);
	const active = observation.read();
	assert.deepEqual(active.peek.tools.active, [
		{ name: "read", elapsedMs: 2000 },
		{ name: "bash", elapsedMs: 0 },
	]);
	clock.advance(1000);
	append(
		lines({
			type: "tool_execution_end",
			toolCallId: "two",
			toolName: "bash",
			result: { content: [{ type: "text", text: "private error" }] },
			isError: true,
		}),
	);
	const ended = observation.read();
	assert.deepEqual(ended.peek.tools, {
		started: 2,
		completed: 1,
		failed: 1,
		names: ["read", "bash"],
		active: [{ name: "read", elapsedMs: 3000 }],
	});
	assert.ok(!JSON.stringify(ended.peek).includes("private"));
});

test("an absent log has no progress, then bounded reads process appended work once", () => {
	const { path, observation, append } = log();
	rmSync(path);
	const absent = observation.read();
	assert.equal(absent.peek.eventCount, 0);
	assert.equal(absent.detectors.lastEventAgeMs, null);
	assert.equal(absent.peek.health.logSizeBytes, 0);
	append(lines({ type: "turn_start" }).repeat(60_000));
	const first = observation.read();
	assert.ok(first.liveView.events.length > 0 && first.liveView.events.length < 60_000);
	assert.equal(first.peek.health.truncated, false);
	const second = observation.read();
	assert.equal(first.liveView.events.length + second.liveView.events.length, 60_000);
	assert.equal(second.peek.turnCount, 60_000);
	assert.equal(observation.read().peek.turnCount, 60_000);
});

test("tool arguments and results stay raw even when they are not objects", () => {
	const events = [
		{ type: "tool_execution_start", toolCallId: "one", toolName: "custom-tool", args: null },
		{
			type: "tool_execution_update",
			toolCallId: "one",
			toolName: "custom-tool",
			args: null,
			partialResult: "private update",
		},
		{
			type: "tool_execution_end",
			toolCallId: "one",
			toolName: "custom-tool",
			result: "private result",
			isError: false,
		},
	];
	const result = log(lines(...events)).observation.read();
	assert.deepEqual(result.liveView.events, events);
	assert.equal(result.peek.health.skippedLines, 0);
	assert.ok(!JSON.stringify(result.peek).includes("private"));
});

test("one read uses one clock value for peek and detector ages", () => {
	const { path, settings, clock } = log(lines({ type: "turn_start" }));
	const observation = createObservation(path, settings, () => {
		clock.advance(1);
		return clock.now();
	});
	const result = observation.read();
	assert.equal(result.peek.lastEventAgeMs, result.detectors.lastEventAgeMs);
});
