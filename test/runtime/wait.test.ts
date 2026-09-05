import type { RunningSubagent, SubagentResult } from "../../src/types.ts";
import {
	afterEach,
	assert,
	describe,
	getCompletedSubagentResultForTest,
	it,
	resetSubagentStateForTest,
	routeDetachedSubagentCompletionForTest,
	setRunningSubagentForTest,
	sleep,
	waitForSubagentForTest,
} from "../support/index.ts";

describe("subagent wait behavior", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	function waitForResult(
		result: SubagentResult & Pick<RunningSubagent, "reportContextUsage" | "sessionFile">,
	) {
		const running: RunningSubagent = {
			id: `child-wait-${Math.random()}`,
			name: result.name,
			task: result.task,
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			reportContextUsage: result.reportContextUsage,
			startTime: Date.now(),
			sessionFile: result.sessionFile,
			completionPromise: Promise.resolve(result),
		};
		setRunningSubagentForTest(running);
		return waitForSubagentForTest({ id: running.id });
	}

	it("includes salvaged child output in provider error results", async () => {
		const waited = await waitForResult({
			name: "Failed child",
			task: "Finish work",
			summary: "Implemented the requested fix.",
			summarySource: "subagent",
			sessionFile: "/tmp/failed-child.jsonl",
			exitCode: 0,
			elapsed: 2,
			errorMessage: "Provider unavailable",
		});
		const text = (waited.content[0] as { text: string }).text;
		assert.match(text, /Last output before the failure \(may be incomplete/);
		assert.match(text, /Implemented the requested fix\./);
		assert.doesNotMatch(text, /did not produce a result/);
	});

	it("appends final child context usage to awaited results", async () => {
		const waited = await waitForResult({
			name: "Context child",
			task: "Finish work",
			summary: "Implemented the requested fix.",
			summarySource: "subagent",
			sessionFile: "/tmp/context-child.jsonl",
			exitCode: 0,
			elapsed: 2,
			contextTokens: 145_000,
			contextWindow: 200_000,
		});
		const text = (waited.content[0] as { text: string }).text;
		assert.match(
			text,
			/Resume: pi --session \/tmp\/context-child\.jsonl\n\nSub-agent context: 145K\/200K tokens \(72%\) used at finish\.$/,
		);
		const details = waited.details as { contextTokens: number; contextWindow: number };
		assert.equal(details.contextTokens, 145_000);
		assert.equal(details.contextWindow, 200_000);
	});

	it("keeps awaited context telemetry structured when the agent definition hides it from the parent result", async () => {
		const waited = await waitForResult({
			name: "Quiet context child",
			task: "Finish work",
			summary: "Implemented the requested fix.",
			summarySource: "subagent",
			sessionFile: "/tmp/quiet-context-child.jsonl",
			exitCode: 0,
			elapsed: 2,
			contextTokens: 145_000,
			contextWindow: 200_000,
			reportContextUsage: false,
		});
		const text = (waited.content[0] as { text: string }).text;
		assert.doesNotMatch(text, /Sub-agent context:/);
		const details = waited.details as { contextTokens: number; contextWindow: number };
		assert.equal(details.contextTokens, 145_000);
		assert.equal(details.contextWindow, 200_000);
	});

	it("classifies an awaited enforced timeout wrap-up", async () => {
		const waited = await waitForResult({
			name: "Wrap-up child",
			task: "Finish work",
			summary: "Reported the committed portion.",
			summarySource: "subagent",
			sessionFile: "/tmp/wrap-up-child.jsonl",
			exitCode: 0,
			elapsed: 36,
			timeoutWrapUp: { kind: "timeout", seconds: 60, threshold: 50 },
		});
		const text = (waited.content[0] as { text: string }).text;
		assert.match(text, /completed its time-limit wrap-up/);
		assert.match(text, /interrupted its active operation at 50% of its whole-run limit/);
		assert.match(text, /Reported the committed portion/);
		const details = waited.details as { timeoutWrapUp: SubagentResult["timeoutWrapUp"] };
		assert.deepEqual(details.timeoutWrapUp, {
			kind: "timeout",
			seconds: 60,
			threshold: 50,
		});
	});

	it("reports no result when a provider error has only watcher fallback output", async () => {
		const waited = await waitForResult({
			name: "Failed child",
			task: "Finish work",
			summary: "Background agent exited without output",
			summarySource: "runtime",
			sessionFile: "/tmp/failed-child.jsonl",
			exitCode: 1,
			elapsed: 2,
			errorMessage: "Provider unavailable",
		});
		const text = (waited.content[0] as { text: string }).text;
		assert.match(text, /The subagent did not produce a result\./);
		assert.doesNotMatch(text, /Last output before the failure/);
	});

	it("includes the child message in ping results", async () => {
		const waited = await waitForResult({
			name: "Ping child",
			task: "Investigate",
			summary: "",
			sessionFile: "/tmp/ping-child.jsonl",
			exitCode: 0,
			elapsed: 1,
			ping: { name: "Ping child", message: "Which API version should I use?" },
		});
		const text = (waited.content[0] as { text: string }).text;
		assert.match(text, /Message from the subagent:\nWhich API version should I use\?/);
	});

	it("returns cached result when wait follows steer delivery", async () => {
		const sent: Array<{ message: unknown; options: unknown }> = [];
		const running: RunningSubagent = {
			id: "child-wait-2",
			name: "Already delivered child",
			task: "Too late",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			startTime: Date.now(),
			sessionFile: "/tmp/child-wait-2.jsonl",
		};

		routeDetachedSubagentCompletionForTest(
			{
				sendMessage(message, options) {
					sent.push({ message, options });
				},
			},
			running,
			{
				name: running.name,
				task: running.task,
				summary: "Detached completion summary",
				sessionFile: running.sessionFile,
				exitCode: 0,
				elapsed: 1,
			},
		);

		const waited = await waitForSubagentForTest({ id: running.id });
		assert.equal(sent.length, 1);
		const details = waited.details as {
			id: string;
			name: string;
			status: string;
			deliveryState: string;
			exitCode: number;
		};
		assert.equal(details.id, running.id);
		assert.equal(details.name, running.name);
		assert.equal(details.status, "completed");
		assert.equal(details.deliveryState, "awaited");
		assert.equal(details.exitCode, 0);
	});

	it("returns pending on wait timeout and restores detached delivery", async () => {
		const sent: Array<{ message: unknown; options: unknown }> = [];
		let resolveCompletion!: (result: SubagentResult) => void;
		const completionPromise = new Promise<SubagentResult>((resolve) => {
			resolveCompletion = resolve;
		});
		const running: RunningSubagent = {
			id: "child-wait-3",
			name: "Slow child",
			task: "Still running",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			startTime: Date.now(),
			sessionFile: "/tmp/child-wait-3.jsonl",
			completionPromise,
		};

		setRunningSubagentForTest(running);
		completionPromise.then((result) => {
			routeDetachedSubagentCompletionForTest(
				{
					sendMessage(message, options) {
						sent.push({ message, options });
					},
				},
				running,
				result,
			);
		});

		const waited = await waitForSubagentForTest({
			id: running.id,
			timeout: 0.01,
			onTimeout: "detach",
		});

		const details = waited.details as { status: string; deliveryState: string };
		assert.equal(details.status, "pending");
		assert.equal(details.deliveryState, "detached");
		assert.equal(running.deliveryState, "detached");

		resolveCompletion({
			name: running.name,
			task: running.task,
			summary: "Late completion summary",
			sessionFile: running.sessionFile,
			exitCode: 0,
			elapsed: 3,
		});
		await sleep(0);

		assert.equal(sent.length, 1);
		assert.equal(
			(sent[0].message as { details: { id: string; deliveryState: string } }).details.id,
			running.id,
		);
		assert.equal(
			(sent[0].message as { details: { id: string; deliveryState: string } }).details.deliveryState,
			"detached",
		);
		assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "steer");
	});

	it("returns timeout errors for wait and restores detached delivery", async () => {
		const sent: Array<{ message: unknown; options: unknown }> = [];
		let resolveCompletion!: (result: SubagentResult) => void;
		const completionPromise = new Promise<SubagentResult>((resolve) => {
			resolveCompletion = resolve;
		});
		const running: RunningSubagent = {
			id: "child-wait-timeout-error",
			name: "Timeout child",
			task: "Miss the deadline",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			startTime: Date.now(),
			sessionFile: "/tmp/child-wait-timeout-error.jsonl",
			completionPromise,
		};

		setRunningSubagentForTest(running);
		completionPromise.then((result) => {
			routeDetachedSubagentCompletionForTest(
				{
					sendMessage(message, options) {
						sent.push({ message, options });
					},
				},
				running,
				result,
			);
		});

		const waited = await waitForSubagentForTest({
			id: running.id,
			timeout: 0.01,
		});
		const details = waited.details as { error: string };
		assert.equal(details.error, "timeout");
		assert.equal(running.deliveryState, "detached");
		assert.equal(running.resultOwner, undefined);

		resolveCompletion({
			name: running.name,
			task: running.task,
			summary: "Late timeout summary",
			sessionFile: running.sessionFile,
			exitCode: 0,
			elapsed: 7,
		});
		await sleep(0);

		assert.equal(sent.length, 1);
		assert.equal(
			(sent[0].message as { details: { id: string; deliveryState: string } }).details.id,
			running.id,
		);
		assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "steer");
	});

	it("releases awaited children back to steer when wait is interrupted", async () => {
		const sent: Array<{ message: unknown; options: unknown }> = [];
		let resolveCompletion!: (result: SubagentResult) => void;
		const completionPromise = new Promise<SubagentResult>((resolve) => {
			resolveCompletion = resolve;
		});
		const running: RunningSubagent = {
			id: "child-wait-interrupt-1",
			name: "Interrupted wait child",
			task: "Resume detached delivery",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			startTime: Date.now(),
			sessionFile: "/tmp/child-wait-interrupt-1.jsonl",
			completionPromise,
		};

		setRunningSubagentForTest(running);
		completionPromise.then((result) => {
			routeDetachedSubagentCompletionForTest(
				{
					sendMessage(message, options) {
						sent.push({ message, options });
					},
				},
				running,
				result,
			);
		});

		const abort = new AbortController();
		const waitPromise = waitForSubagentForTest({ id: running.id }, abort.signal);
		assert.equal(running.deliveryState, "awaited");

		abort.abort();
		const waited = await waitPromise;
		const details = waited.details as { error: string };
		assert.equal(details.error, "interrupted");
		assert.equal(running.deliveryState, "detached");
		assert.equal(running.resultOwner, undefined);

		resolveCompletion({
			name: running.name,
			task: running.task,
			summary: "Interrupted wait summary",
			sessionFile: running.sessionFile,
			exitCode: 0,
			elapsed: 8,
		});
		await sleep(0);

		assert.equal(sent.length, 1);
		assert.equal((sent[0].options as { deliverAs: string }).deliverAs, "steer");
		assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "steer");
	});

	it("explains a context-driven stop and withholds the resume command", async () => {
		const waited = await waitForResult({
			name: "Warned child",
			task: "Finish work",
			summary: "Partial findings.",
			summarySource: "subagent",
			sessionFile: "/tmp/warned-child.jsonl",
			exitCode: 0,
			elapsed: 2,
			contextTokens: 182_000,
			contextWindow: 200_000,
			contextWarned: true,
		});
		const text = (waited.content[0] as { text: string }).text;
		assert.match(text, /stopped early as instructed by its context-warning policy/);
		// Neither the command nor the path: both let a model route around the
		// guard with bash. The operator still gets the path from details.
		assert.doesNotMatch(text, /Session: \/tmp\/warned-child\.jsonl/);
		assert.doesNotMatch(text, /Resume: pi --session/);
	});

	it("does not call a provider failure an expected wrap-up", async () => {
		const waited = await waitForResult({
			name: "Warned failed child",
			task: "Finish work",
			summary: "Background agent exited with code 1",
			summarySource: "runtime",
			sessionFile: "/tmp/warned-failed-child.jsonl",
			exitCode: 1,
			elapsed: 2,
			errorMessage: "Provider unavailable",
			contextExhausted: true,
		});
		const text = (waited.content[0] as { text: string }).text;
		assert.doesNotMatch(text, /not a failure/);
		// The context is spent, but a provider error is often transient, so the
		// parent keeps the cheap retry and is told which option is usually better.
		assert.match(text, /context window is spent/);
		assert.match(text, /fresh subagent is usually better/);
		assert.match(text, /Resume: pi --session/);
	});

	it("still offers resume for an unwarned child that failed without output", async () => {
		const waited = await waitForResult({
			name: "Failed child",
			task: "Finish work",
			summary: "Background agent exited with code 1",
			summarySource: "runtime",
			sessionFile: "/tmp/plain-failed-child.jsonl",
			exitCode: 1,
			elapsed: 2,
			errorMessage: "Provider unavailable",
		});
		const text = (waited.content[0] as { text: string }).text;
		assert.match(text, /resume the session with subagent_resume/);
	});
});
