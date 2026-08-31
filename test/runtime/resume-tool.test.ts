import { resolve } from "node:path";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	fakePiCommand,
	getSubagentBatchStopMetadataForTest,
	it,
	join,
	readFileSync,
	readNonEmptyFileEventually,
	readSubagentLaunchMetadataForTest,
	requestSubagentBatchStopForTest,
	resetSubagentStateForTest,
	writeExecutable,
	writeFileSync,
	writeSubagentLaunchMetadataEntryForTest,
} from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";

describe("subagent_resume coordinator-only-turn", () => {
	afterEach(() => {
		delete process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN;
		resetSubagentStateForTest();
	});

	it("calls requestSubagentBatchStop for async resumes", () => {
		// Simulate what the resume tool does for an async (non-blocking) resume.
		// requestSubagentBatchStop should set the batch-stop flag so that
		// getSubagentBatchStopMetadata returns { terminate: true }.
		requestSubagentBatchStopForTest();
		const meta = getSubagentBatchStopMetadataForTest();
		assert.deepEqual(meta, { terminate: true });
	});

	it("respects coordinator-only-turn opt-out for async resumes", () => {
		process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN = "1";
		requestSubagentBatchStopForTest();
		const meta = getSubagentBatchStopMetadataForTest();
		assert.equal(meta.terminate, undefined);
	});

	it("does not call batch stop for awaited (sync/blocking) resumes", () => {
		// When shouldAwait is true, the resume tool returns
		// runtime.getLaunchedSubagentResult() directly, not the batch-stop path.
		// getSubagentBatchStopMetadata should be empty in this case.
		const meta = getSubagentBatchStopMetadataForTest();
		assert.deepEqual(meta, {});
	});

	it("awaits an async resume when the batch was marked blocking by the classifier", async () => {
		// Mixed-batch contract: when the message_end classifier marks the
		// current batch blocking (async subagent_resume + non-subagent tool),
		// the resume tool must agree with the runtime that the parent should
		// wait. shouldAwaitSubagentLaunch is the shared predicate both the
		// subagent and subagent_resume tools route through.
		const { shouldAwaitSubagentLaunchForTest, markSubagentBatchBlockingForTest } = await import(
			"../support/index.ts"
		);
		const asyncRunning = { blocking: false, async: true };

		// Without the blocking flag, an async resume should not await.
		assert.equal(shouldAwaitSubagentLaunchForTest(asyncRunning), false);

		// With the classifier-marked flag, the same async resume should await.
		markSubagentBatchBlockingForTest();
		assert.equal(shouldAwaitSubagentLaunchForTest(asyncRunning), true);
	});
});

describe("subagent_resume approval args", () => {
	function createResumeRuntime() {
		return {
			isMuxAvailable: () => true,
			getShellReadyDelayMs: () => 0,
			watchBackgroundSubagent: async () => ({
				name: "",
				task: "",
				summary: "",
				exitCode: 0,
				elapsed: 0,
			}),
			watchSubagent: async () => ({
				name: "",
				task: "",
				summary: "",
				exitCode: 0,
				elapsed: 0,
			}),
			getWatcherSignal: (_running: any, controller: AbortController) => controller.signal,
			startWidgetRefresh: () => {},
			getContextWindow: () => undefined,
			runningSubagents: new Map<string, any>(),
		};
	}

	it("passes no-approve when resuming a session without launch metadata", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "capture-pi", `#!/usr/bin/env bash\nexit 0\n`);
		const originalCommand = process.env.PI_SUBAGENT_PI_COMMAND;
		process.env.PI_SUBAGENT_PI_COMMAND = fakePiCommand(bin);
		try {
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({
					type: "session",
					version: 3,
					id: "s",
					timestamp: new Date().toISOString(),
					cwd: dir,
				}) + "\n",
			);

			const running = await resumeSubagentSession(
				{ sessionFile, mode: "background" },
				createResumeRuntime(),
			);

			assert.equal(running.childProcess?.spawnargs.includes("--no-approve"), true);
		} finally {
			if (originalCommand == null) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = originalCommand;
		}
	});

	it("restores the persisted child context threshold on resume", async () => {
		const dir = createTestDir();
		const capturedThreshold = join(dir, "captured-threshold.txt");
		const bin = writeExecutable(
			dir,
			"capture-context-threshold",
			`#!/usr/bin/env bash\nprintf '%s' "$PI_SUBAGENT_CONTEXT_WARN_THRESHOLD" > ${JSON.stringify(capturedThreshold)}\n`,
		);
		const originalCommand = process.env.PI_SUBAGENT_PI_COMMAND;
		process.env.PI_SUBAGENT_PI_COMMAND = fakePiCommand(bin);
		try {
			const sessionFile = join(dir, "context-aware-child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({
					type: "session",
					version: 3,
					id: "s",
					timestamp: new Date().toISOString(),
					cwd: dir,
				}) + "\n",
			);
			await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "context-aware-child",
				mode: "background",
				sessionMode: "lineage-only",
				autoExit: true,
				parentClosePolicy: "terminate",
				async: true,
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: dir,
				cwd: dir,
				boundarySystemPrompt: false,
				contextWarnThreshold: "80%",
			});

			await resumeSubagentSession({ sessionFile }, createResumeRuntime());

			assert.equal(await readNonEmptyFileEventually(capturedThreshold), "80%");
		} finally {
			if (originalCommand == null) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = originalCommand;
		}
	});

	it("restores the persisted parent context reporting opt-out on resume", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "capture-pi", "#!/usr/bin/env bash\nexit 0\n");
		const originalCommand = process.env.PI_SUBAGENT_PI_COMMAND;
		process.env.PI_SUBAGENT_PI_COMMAND = fakePiCommand(bin);
		try {
			const sessionFile = join(dir, "quiet-context-child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({
					type: "session",
					version: 3,
					id: "s",
					timestamp: new Date().toISOString(),
					cwd: dir,
				}) + "\n",
			);
			await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "quiet-context-child",
				mode: "background",
				sessionMode: "lineage-only",
				autoExit: true,
				parentClosePolicy: "terminate",
				async: true,
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: dir,
				cwd: dir,
				boundarySystemPrompt: false,
				reportContextUsage: false,
			});

			const running = await resumeSubagentSession({ sessionFile }, createResumeRuntime());

			assert.equal(running.reportContextUsage, false);
		} finally {
			if (originalCommand == null) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = originalCommand;
		}
	});

	it("does not duplicate generated approval args for metadata-backed background resumes", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "capture-pi", `#!/usr/bin/env bash\nexit 0\n`);
		const originalCommand = process.env.PI_SUBAGENT_PI_COMMAND;
		process.env.PI_SUBAGENT_PI_COMMAND = fakePiCommand(bin);
		try {
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({
					type: "session",
					version: 3,
					id: "s",
					timestamp: new Date().toISOString(),
					cwd: dir,
				}) + "\n",
			);
			await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "resume-child",
				mode: "background",
				sessionMode: "lineage-only",
				autoExit: true,
				parentClosePolicy: "terminate",
				async: true,
				trustProject: true,
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: dir,
				cwd: dir,
				boundarySystemPrompt: false,
			});

			const running = await resumeSubagentSession({ sessionFile }, createResumeRuntime());
			const approvalArgs =
				running.childProcess?.spawnargs.filter(
					(arg) => arg === "--approve" || arg === "--no-approve",
				) ?? [];

			assert.deepEqual(approvalArgs, ["--no-approve"]);
		} finally {
			if (originalCommand == null) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = originalCommand;
		}
	});

	it("uses the persisted metadata mode for resume approval policy, ignoring an explicit mode argument", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "capture-pi", `#!/usr/bin/env bash\nexit 0\n`);
		const originalCommand = process.env.PI_SUBAGENT_PI_COMMAND;
		process.env.PI_SUBAGENT_PI_COMMAND = fakePiCommand(bin);
		try {
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({
					type: "session",
					version: 3,
					id: "s",
					timestamp: new Date().toISOString(),
					cwd: dir,
				}) + "\n",
			);
			await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "trusted-background",
				mode: "background",
				sessionMode: "lineage-only",
				autoExit: true,
				parentClosePolicy: "terminate",
				async: true,
				trustProject: true,
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: dir,
				cwd: dir,
				boundarySystemPrompt: false,
			});

			// Persisted metadata (background) wins over the explicit interactive
			// mode argument, so the resume stays background and uses --no-approve.
			const running = await resumeSubagentSession(
				{ sessionFile, mode: "interactive" },
				createResumeRuntime(),
			);
			const approvalArgs =
				running.childProcess?.spawnargs.filter(
					(arg) => arg === "--approve" || arg === "--no-approve",
				) ?? [];

			assert.equal(running.mode, "background");
			assert.deepEqual(approvalArgs, ["--no-approve"]);
		} finally {
			if (originalCommand == null) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = originalCommand;
		}
	});
});

describe("subagent_resume extension parity", () => {
	function createResumeRuntime() {
		return {
			isMuxAvailable: () => true,
			getShellReadyDelayMs: () => 0,
			watchBackgroundSubagent: async () => ({
				name: "",
				task: "",
				summary: "",
				exitCode: 0,
				elapsed: 0,
			}),
			watchSubagent: async () => ({
				name: "",
				task: "",
				summary: "",
				exitCode: 0,
				elapsed: 0,
			}),
			getWatcherSignal: (_running: any, controller: AbortController) => controller.signal,
			startWidgetRefresh: () => {},
			getContextWindow: () => undefined,
			runningSubagents: new Map<string, any>(),
		};
	}

	it("keeps normal extension discovery for metadata-backed extensions all resumes", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "capture-pi", `#!/usr/bin/env bash\nexit 0\n`);
		const originalCommand = process.env.PI_SUBAGENT_PI_COMMAND;
		process.env.PI_SUBAGENT_PI_COMMAND = fakePiCommand(bin);
		try {
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({
					type: "session",
					version: 3,
					id: "s",
					timestamp: new Date().toISOString(),
					cwd: dir,
				}) + "\n",
			);
			await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "resume-child",
				mode: "background",
				sessionMode: "lineage-only",
				autoExit: true,
				parentClosePolicy: "terminate",
				async: true,
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: dir,
				cwd: dir,
				boundarySystemPrompt: false,
			});

			const running = await resumeSubagentSession({ sessionFile }, createResumeRuntime());

			assert.equal(running.childProcess?.spawnargs.includes("--no-extensions"), false);
		} finally {
			if (originalCommand == null) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = originalCommand;
		}
	});

	it("keeps extension discovery disabled when legacy sessions have no extension metadata", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "capture-pi", `#!/usr/bin/env bash\nexit 0\n`);
		const originalCommand = process.env.PI_SUBAGENT_PI_COMMAND;
		process.env.PI_SUBAGENT_PI_COMMAND = fakePiCommand(bin);
		try {
			const sessionFile = join(dir, "legacy-child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({
					type: "session",
					version: 3,
					id: "s",
					timestamp: new Date().toISOString(),
					cwd: dir,
				}) + "\n",
			);

			const running = await resumeSubagentSession(
				{ sessionFile, mode: "background" },
				createResumeRuntime(),
			);

			assert.equal(running.childProcess?.spawnargs.includes("--no-extensions"), true);
		} finally {
			if (originalCommand == null) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = originalCommand;
		}
	});
});

describe("subagent_resume same-session guard", () => {
	it("does not persist resume override metadata before duplicate-session guard", async () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(
			sessionFile,
			JSON.stringify({
				type: "session",
				version: 3,
				id: "s",
				timestamp: new Date().toISOString(),
				cwd: dir,
			}) + "\n",
		);
		await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
			version: 1,
			timestamp: "2026-05-08T00:00:00.000Z",
			name: "scout",
			agent: "scout",
			mode: "background",
			sessionMode: "lineage-only",
			autoExit: true,
			parentClosePolicy: "terminate",
			async: true,
			model: "zai-messages/glm-5.1",
			modelRef: "zai-messages/glm-5.1",
			allowModelOverride: true,
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: dir,
			cwd: dir,
			boundarySystemPrompt: false,
		});

		const runningSubagents = new Map<string, any>();
		runningSubagents.set("existing-001", {
			id: "existing-001",
			name: "scout",
			agent: "scout",
			sessionFile,
		});

		await assert.rejects(
			() =>
				resumeSubagentSession(
					{ sessionFile, model: "zai-messages/glm-5-turbo", thinking: "off" },
					{
						isMuxAvailable: () => true,
						getShellReadyDelayMs: () => 0,
						watchBackgroundSubagent: async () => ({
							name: "",
							task: "",
							summary: "",
							exitCode: 0,
							elapsed: 0,
						}),
						watchSubagent: async () => ({
							name: "",
							task: "",
							summary: "",
							exitCode: 0,
							elapsed: 0,
						}),
						getWatcherSignal: (_running: any, controller: AbortController) => controller.signal,
						startWidgetRefresh: () => {},
						getContextWindow: () => undefined,
						runningSubagents,
						modelRegistry: {
							getAvailable: () => [
								{ provider: "zai-messages", id: "glm-5-turbo" },
								{ provider: "zai-messages", id: "glm-5.1" },
							],
						},
					},
				),
			/already running/,
		);

		const metadata = readSubagentLaunchMetadataForTest(sessionFile);
		assert.equal(metadata?.modelRef, "zai-messages/glm-5.1");
		assert.equal(metadata?.requestedModelOverride, undefined);
		assert.equal(metadata?.requestedThinkingOverride, undefined);
	});

	it("detects duplicate sessionFile in running subagents", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(
			sessionFile,
			JSON.stringify({
				type: "session",
				version: 3,
				id: "s",
				timestamp: new Date().toISOString(),
				cwd: dir,
			}) + "\n",
		);

		const runningSubagents = new Map<string, any>();
		const existingId = "existing-001";
		runningSubagents.set(existingId, {
			id: existingId,
			name: "magician",
			agent: "magician",
			sessionFile,
			mode: "interactive",
			deliveryState: "detached",
			parentClosePolicy: "terminate",
			blocking: false,
			async: true,
			task: "Do magic",
		});

		// Simulate the same-session guard from resume-tool.ts
		const normalizedFile = resolve(sessionFile);
		let guardResult: any = null;
		for (const existing of runningSubagents.values()) {
			if (existing.sessionFile && resolve(existing.sessionFile) === normalizedFile) {
				guardResult = {
					id: existing.id,
					name: existing.name,
					content: `Session "${existing.name}" (${existing.agent ?? "subagent"}) is already running with id ${existing.id}.`,
				};
				break;
			}
		}

		assert.ok(guardResult, "Guard should have triggered");
		assert.equal(guardResult!.name, "magician");
		assert.equal(guardResult!.id, existingId);
		assert.match(
			guardResult!.content,
			/existing-001/,
			"Should reference the existing running subagent id",
		);
	});

	it("does not trigger guard when sessionFile differs", () => {
		const runningSubagents = new Map<string, any>();
		runningSubagents.set("existing-001", {
			id: "existing-001",
			name: "scout",
			sessionFile: "/tmp/other-session.jsonl",
		});

		const newSessionFile = "/tmp/different-session.jsonl";
		const normalizedFile = resolve(newSessionFile);
		let guardResult: any = null;
		for (const existing of runningSubagents.values()) {
			if (existing.sessionFile && resolve(existing.sessionFile) === normalizedFile) {
				guardResult = { id: existing.id };
				break;
			}
		}

		assert.equal(guardResult, null, "Guard should not trigger for different session files");
	});
});
