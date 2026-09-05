import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	endedUnderContextPressure,
	findCallerPings,
	findSubagentError,
	getEntries,
	getNewEntries,
	sumSessionOutputTokens,
} from "../../src/session/session.ts";

function writeSession(t: TestContext, entries: object[]): string {
	const dir = mkdtempSync(join(tmpdir(), "session-extractors-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "child.jsonl");
	writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return file;
}

test("sums output usage from assistant messages, tool results, and summaries once", (t) => {
	const file = writeSession(t, [
		{ type: "session", id: "session" },
		{ type: "message", id: "one", message: { role: "assistant", usage: { output: 12 } } },
		{ type: "message", id: "two", message: { role: "assistant", usage: { output: 8 } } },
		{ type: "message", id: "tool", message: { role: "toolResult", usage: { output: 3 } } },
		{
			type: "compaction",
			id: "compact",
			usage: { output: 5 },
			retainedTail: [{ role: "assistant", usage: { output: 8 } }],
		},
		{ type: "branch_summary", id: "branch", usage: { output: 2 } },
	]);
	assert.equal(sumSessionOutputTokens(getEntries(file)), 30);
});

test("ignores missing, invalid, and unrelated output usage", (t) => {
	const file = writeSession(t, [
		{ type: "message", id: "missing" },
		{ type: "message", id: "null", message: null },
		{ type: "message", id: "no-usage", message: { role: "assistant" } },
		{ type: "message", id: "text-count", message: { role: "assistant", usage: { output: "9" } } },
		{ type: "message", id: "negative", message: { role: "assistant", usage: { output: -3 } } },
		{ type: "message", id: "fraction", message: { role: "assistant", usage: { output: 1.5 } } },
		{ type: "message", id: "user", message: { role: "user", usage: { output: 90 } } },
		{ type: "custom", id: "custom", usage: { output: 80 } },
		{ type: "message", id: "valid", message: { role: "assistant", usage: { output: 7 } } },
	]);
	assert.equal(sumSessionOutputTokens(getEntries(file)), 7);
	assert.equal(sumSessionOutputTokens([]), 0);
});

test("reads each caller_ping argument in order, without needing a tool result", (t) => {
	const file = writeSession(t, [
		{
			type: "message",
			id: "calls",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "caller_ping is not a tool call here" },
					{
						type: "toolCall",
						id: "ping-one",
						name: "caller_ping",
						arguments: { message: "Need a path.\nWhich file?" },
					},
					{ type: "toolCall", id: "other", name: "bash", arguments: { message: "not a ping" } },
					{
						type: "toolCall",
						id: "ping-two",
						name: "caller_ping",
						arguments: { message: "Ready.", extra: true },
					},
				],
			},
		},
		{
			type: "message",
			id: "result",
			message: {
				role: "toolResult",
				toolName: "caller_ping",
				content: [{ type: "text", text: "Ping sent." }],
			},
		},
	]);
	assert.deepEqual(findCallerPings(getEntries(file)), [
		{ toolCallId: "ping-one", message: "Need a path.\nWhich file?" },
		{ toolCallId: "ping-two", message: "Ready." },
	]);
});

test("returns the terminal assistant error even when it has partial text", (t) => {
	const file = writeSession(t, [
		{
			type: "message",
			id: "failed",
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "  Provider unavailable  ",
				content: [{ type: "text", text: "Partial work." }],
			},
		},
		{ type: "custom", id: "after", customType: "extension-state" },
	]);
	assert.deepEqual(findSubagentError(getEntries(file)), {
		stopReason: "error",
		errorMessage: "  Provider unavailable  ",
	});
});

test("keeps an error result when the provider message is absent or invalid", (t) => {
	for (const errorMessage of [undefined, "", " \n ", 42, null]) {
		const file = writeSession(t, [
			{
				type: "message",
				id: "failed",
				message: { role: "assistant", stopReason: "error", errorMessage },
			},
		]);
		assert.deepEqual(findSubagentError(getEntries(file)), {
			stopReason: "error",
			errorMessage: "Subagent error",
		});
	}
});

test("ignores invalid ping blocks and calls outside assistant messages", (t) => {
	const invalidContent = [
		null,
		"caller_ping",
		{},
		{ type: "toolCall", id: "missing", name: "caller_ping" },
		{ type: "toolCall", id: "null-args", name: "caller_ping", arguments: null },
		{ type: "toolCall", id: "bad-message", name: "caller_ping", arguments: { message: 4 } },
		{ type: "toolCall", name: "caller_ping", arguments: { message: "missing id" } },
	];
	const file = writeSession(t, [
		{ type: "message", id: "missing" },
		{ type: "message", id: "bad-content", message: { role: "assistant", content: "caller_ping" } },
		{ type: "message", id: "invalid", message: { role: "assistant", content: invalidContent } },
		{
			type: "message",
			id: "user",
			message: {
				role: "user",
				content: [
					{
						type: "toolCall",
						id: "example",
						name: "caller_ping",
						arguments: { message: "quoted call" },
					},
				],
			},
		},
	]);
	assert.deepEqual(findCallerPings(getEntries(file)), []);
	assert.deepEqual(findCallerPings([]), []);
});

test("does not revive an earlier provider error after a later assistant turn", (t) => {
	for (const stopReason of ["stop", "toolUse", "aborted", "length", undefined]) {
		const file = writeSession(t, [
			{
				type: "message",
				id: "error",
				message: { role: "assistant", stopReason: "error", errorMessage: "Old failure" },
			},
			{ type: "message", id: "latest", message: { role: "assistant", stopReason, content: [] } },
			{
				type: "message",
				id: "tool-error",
				message: { role: "toolResult", isError: true, errorMessage: "Not a provider error" },
			},
		]);
		assert.equal(findSubagentError(getEntries(file)), undefined);
	}
	assert.equal(findSubagentError([]), undefined);
});

test("reads only the supplied run entries and ignores conflicting sidecar evidence", (t) => {
	const file = writeSession(t, [
		{
			type: "message",
			id: "old",
			message: {
				role: "assistant",
				usage: { output: 900 },
				stopReason: "error",
				errorMessage: "Old failure",
				content: [
					{
						type: "toolCall",
						id: "old-ping",
						name: "caller_ping",
						arguments: { message: "Old request" },
					},
				],
			},
		},
		{
			type: "custom",
			id: "old-marker",
			parentId: "old",
			customType: "pi-subagent-completion",
			data: { reason: "context-pressure" },
		},
		{
			type: "message",
			id: "current",
			parentId: "old-marker",
			message: { role: "assistant", usage: { output: 4 }, stopReason: "stop", content: [] },
		},
		{
			type: "custom",
			id: "current-marker",
			parentId: "current",
			customType: "pi-subagent-completion",
			data: { reason: "normal" },
		},
	]);
	writeFileSync(
		`${file}.exit`,
		JSON.stringify({
			type: "ping",
			message: "Wrong evidence",
			outputTokens: 999,
			completionReason: "context-pressure",
		}),
	);
	const entries = getNewEntries(file, 2);
	assert.equal(sumSessionOutputTokens(entries), 4);
	assert.deepEqual(findCallerPings(entries), []);
	assert.equal(findSubagentError(entries), undefined);
	assert.equal(endedUnderContextPressure(file), false);
});

test("rejects damaged JSONL rather than reporting a partial scan as complete", (t) => {
	const file = writeSession(t, []);
	writeFileSync(file, '{"type":"session","id":"header"}\n{"type":"message"');
	assert.throws(() => sumSessionOutputTokens(getEntries(file)), /Invalid session JSONL at .*:2:/);
	assert.throws(() => findCallerPings(getEntries(file)), /Invalid session JSONL at .*:2:/);
	assert.throws(() => findSubagentError(getEntries(file)), /Invalid session JSONL at .*:2:/);
	assert.equal(endedUnderContextPressure(file), false);
});

const fixturesDir = new URL("../fixtures/pi-sessions/", import.meta.url);
const recordedFiles = readdirSync(fixturesDir, { recursive: true, encoding: "utf8" })
	.filter((file) => file.endsWith(".jsonl"))
	.sort();

test("the recorded session set covers both local model families and provider failure", () => {
	assert.equal(recordedFiles.length, 5);
	const totals = recordedFiles.map((file) => {
		const meta = JSON.parse(
			readFileSync(new URL(file.replace(/\.jsonl$/, ".meta.json"), fixturesDir), "utf8"),
		);
		return meta.evidence.totalOutputTokens;
	});
	// These worked totals are also listed in the fixture README.
	assert.deepEqual(
		totals.sort((a, b) => a - b),
		[0, 49, 58, 172, 442],
	);
});

for (const name of recordedFiles) {
	test(`reads recorded session evidence: ${name}`, () => {
		const file = new URL(name, fixturesDir);
		const raw = readFileSync(file);
		const meta = JSON.parse(
			readFileSync(new URL(name.replace(/\.jsonl$/, ".meta.json"), fixturesDir), "utf8"),
		);
		assert.equal(meta.source, "recorded");
		assert.match(meta.piVersion, /^\d+\.\d+\.\d+$/);
		assert.equal(createHash("sha256").update(raw).digest("hex"), meta.rawSessionSha256);
		assert.deepEqual(meta.transforms, []);
		const entries = getEntries(fileURLToPath(file));
		// Expected usage is a saved recording value, not a sum computed in this test.
		assert.equal(sumSessionOutputTokens(entries), meta.evidence.totalOutputTokens);
		assert.deepEqual(
			findCallerPings(entries).map((ping) => ping.message),
			meta.scenario === "tool-ping" ? ["Fixture help: confirm the next step."] : [],
		);
		assert.deepEqual(
			findSubagentError(entries),
			meta.scenario === "provider-error"
				? { stopReason: "error", errorMessage: "Connection error." }
				: undefined,
		);
		assert.equal(
			endedUnderContextPressure(fileURLToPath(file)),
			meta.scenario === "context-pressure",
		);
	});
}
