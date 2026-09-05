import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	getAgentListSignatureForTest,
	getCompletedSubagentResultForTest,
	getLaunchedSubagentResultForTest,
	it,
	join,
	markSubagentBatchBlockingForTest,
	mkdirSync,
	renderAgentListReminderForTest,
	resetSubagentStateForTest,
	routeDetachedSubagentCompletionForTest,
	setRunningSubagentForTest,
	subagentsExtension,
	waitForSubagentForTest,
	writeFileSync,
} from "../support/index.ts";

describe("subagent launch result delivery", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("marks async detached launch results as terminating the current tool batch", async () => {
		const running = {
			id: "child-terminate",
			name: "Child",
			task: "Do work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-terminate.jsonl",
		};

		const result = await getLaunchedSubagentResultForTest(running);
		const details = result.details as { status: string };
		assert.equal(details.status, "started");
		assert.equal(result.terminate, true);
	});

	it("does not terminate async launch results when coordinator-only turn stop is disabled", async () => {
		process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN = "1";
		const running = {
			id: "child-no-terminate-opt-out",
			name: "Child",
			task: "Do work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-no-terminate-opt-out.jsonl",
		};

		const result = await getLaunchedSubagentResultForTest(running);
		const details = result.details as { status: string; async: boolean };
		assert.equal(details.status, "started");
		assert.equal(details.async, true);
		assert.equal(result.terminate, undefined);
	});

	it("does not defer same-turn detached async completion when coordinator-only turn stop is disabled", async () => {
		process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN = "1";
		const sent: Array<{ message: unknown; options: unknown }> = [];
		const running = {
			id: "child-no-defer-opt-out",
			name: "Async child",
			task: "Start work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-no-defer-opt-out.jsonl",
		};

		setRunningSubagentForTest(running);
		const asyncResult = await getLaunchedSubagentResultForTest(running);
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
				summary: "Async done",
				sessionFile: running.sessionFile,
				exitCode: 0,
				elapsed: 1,
			},
		);

		assert.equal(asyncResult.terminate, undefined);
		assert.equal(sent.length, 1);
		assert.equal((sent[0].options as { deliverAs: string }).deliverAs, "steer");
	});

	it("defers same-turn detached async completion delivery until the next user turn", async () => {
		const sent: Array<{ message: unknown; options: unknown }> = [];
		const running = {
			id: "child-deferred-steer",
			name: "Async child",
			task: "Start work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-deferred-steer.jsonl",
		};

		setRunningSubagentForTest(running);
		const asyncResult = await getLaunchedSubagentResultForTest(running);
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
				summary: "Async done",
				sessionFile: running.sessionFile,
				exitCode: 0,
				elapsed: 1,
			},
		);

		assert.equal(asyncResult.terminate, true);
		assert.equal(sent.length, 1);
		assert.equal((sent[0].options as { deliverAs: string }).deliverAs, "nextTurn");
		assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "steer");
	});

	it("awaits async children when the current subagent batch has a sync child", async () => {
		markSubagentBatchBlockingForTest();
		const asyncRunning = {
			id: "child-mixed-async-awaited",
			name: "Async child",
			task: "Start work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-mixed-async-awaited.jsonl",
			completionPromise: Promise.resolve({
				name: "Async child",
				task: "Start work",
				summary: "Async done",
				sessionFile: "/tmp/child-mixed-async-awaited.jsonl",
				exitCode: 0,
				elapsed: 1,
			}),
		};

		setRunningSubagentForTest(asyncRunning);
		const asyncResult = await getLaunchedSubagentResultForTest(asyncRunning);
		const details = asyncResult.details as {
			status: string;
			deliveryState: string;
			async: boolean;
		};
		assert.equal(details.status, "completed");
		assert.equal(details.deliveryState, "awaited");
		assert.equal(details.async, true);
		assert.equal(asyncResult.terminate, undefined);
		assert.equal(getCompletedSubagentResultForTest(asyncRunning.id)?.deliveredTo, "wait");
	});

	it("does not mark mixed async and sync launch results as terminating when coordinator-only turn stop is disabled", async () => {
		process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN = "1";
		const asyncRunning = {
			id: "child-mixed-async-opt-out",
			name: "Async child",
			task: "Start work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-mixed-async-opt-out.jsonl",
		};
		const syncRunning = {
			id: "child-mixed-sync-opt-out",
			name: "Sync child",
			task: "Gate work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: true,
			async: false,
			startTime: Date.now(),
			sessionFile: "/tmp/child-mixed-sync-opt-out.jsonl",
			completionPromise: Promise.resolve({
				name: "Sync child",
				task: "Gate work",
				summary: "Done",
				sessionFile: "/tmp/child-mixed-sync-opt-out.jsonl",
				exitCode: 0,
				elapsed: 1,
			}),
		};

		setRunningSubagentForTest(asyncRunning);
		setRunningSubagentForTest(syncRunning);
		const asyncResult = await getLaunchedSubagentResultForTest(asyncRunning);
		const syncResult = await getLaunchedSubagentResultForTest(syncRunning);
		assert.equal(asyncResult.terminate, undefined);
		const details = syncResult.details as { status: string };
		assert.equal(details.status, "completed");
		assert.equal(syncResult.terminate, undefined);
	});

	it("does not mark sync launch results as terminating the current tool batch", async () => {
		const running = {
			id: "child-sync-no-terminate",
			name: "Child",
			task: "Do work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: true,
			async: false,
			startTime: Date.now(),
			sessionFile: "/tmp/child-sync-no-terminate.jsonl",
			completionPromise: Promise.resolve({
				name: "Child",
				task: "Do work",
				summary: "Done",
				sessionFile: "/tmp/child-sync-no-terminate.jsonl",
				exitCode: 0,
				elapsed: 1,
			}),
		};

		setRunningSubagentForTest(running);
		const result = await getLaunchedSubagentResultForTest(running);
		const details = result.details as { status: string };
		assert.equal(details.status, "completed");
		assert.equal(result.terminate, undefined);
	});

	it("keeps parent tools available after waiting for detached children", async () => {
		const running = {
			id: "child-guard",
			name: "Child",
			task: "Do work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			startTime: Date.now(),
			sessionFile: "/tmp/child-guard.jsonl",
			completionPromise: Promise.resolve({
				name: "Child",
				task: "Do work",
				summary: "Done",
				sessionFile: "/tmp/child-guard.jsonl",
				exitCode: 0,
				elapsed: 1,
			}),
		};

		setRunningSubagentForTest(running);
		const waited = await waitForSubagentForTest({ id: "Child" });
		const details = waited.details as { status: string };
		assert.equal(details.status, "completed");
		assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "wait");
	});

	it("injects one hidden startup catalog for top-level actionable sessions", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			`---\nname: reviewer\ndescription: Review changes for regressions\nmode: background\n---\n\nReviewer body.`,
		);

		const handlers = new Map<string, unknown>();
		// @ts-expect-error: This test API includes only the registration and message methods used here.
		subagentsExtension({
			on(event: string, handler: unknown) {
				handlers.set(event, handler);
			},
			registerCommand() {},
			registerMessageRenderer() {},
			registerTool() {},
			sendMessage() {},
		});

		const sessionStart = handlers.get("session_start") as (
			event: SessionStartEvent,
			ctx: ExtensionContext,
		) => void;
		const beforeAgentStart = handlers.get("before_agent_start") as (
			event: BeforeAgentStartEvent,
		) => BeforeAgentStartEventResult | undefined;

		const ctx = {
			cwd: dir,
			hasUI: false,
			ui: { setWidget() {} },
			sessionManager: {
				getHeader: () => ({
					id: "root",
					type: "session",
					timestamp: "",
					cwd: dir,
				}),
			},
		};
		// @ts-expect-error: This context has only the widget and session header methods read at startup.
		sessionStart({ type: "session_start", reason: "startup" }, ctx);

		const result = beforeAgentStart({
			type: "before_agent_start",
			prompt: "hi",
			systemPrompt: "sys",
			systemPromptOptions: { cwd: dir },
		});
		const message = result?.message;
		assert.ok(message);
		assert.equal(message.customType, "subagent_roster");
		assert.equal(message.display, false);
		const details = message.details as {
			entries: Parameters<typeof getAgentListSignatureForTest>[0];
			signature: string;
		};
		assert.equal(details.entries[0].name, "reviewer");
		assert.equal(details.signature, getAgentListSignatureForTest(details.entries));
		assert.ok(typeof message.content === "string");
		assert.match(message.content, /^<system-reminder>\nYou can launch separate helper agents/);
		assert.match(
			message.content,
			/`reviewer`: Review changes for regressions[\s\S]*?tool_return: later_message/m,
		);
		assert.match(message.content, /\n<\/subagent-roster>\n<subagent-rules>\n/);
		assert.match(
			message.content,
			/tool_return=later_message means the tool call starts the helper and returns before the work is done; do not invent its findings/,
		);
		assert.match(
			message.content,
			/context=fresh_chat_needs_full_brief means write a self-contained task with objective, files, constraints, and expected output/,
		);
		assert.match(
			message.content,
			/context=copy_of_this_chat means the helper starts from this conversation/,
		);
		assert.match(message.content, /\n<\/subagent-rules>\n<\/system-reminder>$/);
		assert.equal(renderAgentListReminderForTest(details.entries), message.content);
		assert.equal(
			beforeAgentStart({
				type: "before_agent_start",
				prompt: "again",
				systemPrompt: "sys",
				systemPromptOptions: { cwd: dir },
			}),
			undefined,
		);
	});

	it("queues reload catalog changes for the next turn instead of interrupting immediately", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			`---\nname: reviewer\ndescription: Review changes for regressions\n---\n\nReviewer body.`,
		);

		const handlers = new Map<string, unknown>();
		const ctx = {
			cwd: dir,
			hasUI: false,
			ui: { setWidget() {} },
			sessionManager: {
				getHeader: () => ({
					id: "root",
					type: "session",
					timestamp: "",
					cwd: dir,
				}),
			},
		};

		// @ts-expect-error: This test API includes only the registration and message methods used here.
		subagentsExtension({
			on(event: string, handler: unknown) {
				handlers.set(event, handler);
			},
			registerCommand() {},
			registerMessageRenderer() {},
			registerTool() {},
			sendMessage() {},
		});

		const sessionStart = handlers.get("session_start") as (
			event: SessionStartEvent,
			ctx: ExtensionContext,
		) => void;
		const beforeAgentStart = handlers.get("before_agent_start") as (
			event: BeforeAgentStartEvent,
		) => BeforeAgentStartEventResult | undefined;

		// @ts-expect-error: This context has only the widget and session header methods read at startup.
		sessionStart({ type: "session_start", reason: "startup" }, ctx);
		const startup = beforeAgentStart({
			type: "before_agent_start",
			prompt: "start",
			systemPrompt: "sys",
			systemPromptOptions: { cwd: dir },
		});
		assert.ok(startup?.message);
		assert.equal((startup.message.details as { supersedes?: boolean }).supersedes, undefined);

		writeFileSync(
			join(agentsDir, "researcher.md"),
			`---\nname: researcher\ndescription: Investigate open-ended questions\nmode: background\n---\n\nResearcher body.`,
		);

		// @ts-expect-error: This context has only the widget and session header methods read at startup.
		sessionStart({ type: "session_start", reason: "reload" }, ctx);
		const reloaded = beforeAgentStart({
			type: "before_agent_start",
			prompt: "continue",
			systemPrompt: "sys",
			systemPromptOptions: { cwd: dir },
		});
		assert.ok(reloaded?.message);
		assert.equal((reloaded.message.details as { supersedes?: boolean }).supersedes, true);
		assert.ok(typeof reloaded.message.content === "string");
		assert.match(
			reloaded.message.content,
			/`researcher`: Investigate open-ended questions[\s\S]*?tool_return: later_message[\s\S]*?runs_as: hidden_process[\s\S]*?context: fresh_chat_needs_full_brief[\s\S]*?completion: exits_automatically/,
		);

		// @ts-expect-error: This context has only the widget and session header methods read at startup.
		sessionStart({ type: "session_start", reason: "reload" }, ctx);
		assert.equal(
			beforeAgentStart({
				type: "before_agent_start",
				prompt: "continue again",
				systemPrompt: "sys",
				systemPromptOptions: { cwd: dir },
			}),
			undefined,
		);
	});
});
