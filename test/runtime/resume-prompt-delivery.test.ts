import { spawn } from "node:child_process";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import {
	assert,
	createTestDir,
	describe,
	fakePiCommand,
	it,
	join,
	mkdirSync,
	readFileSync,
	readNonEmptyFileEventually,
	writeExecutable,
	writeFileSync,
	writeResumeTaskArtifactForTest,
	writeSubagentLaunchMetadataEntryForTest,
} from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";

describe("subagent_resume prompt delivery", () => {
	it("writes a direct sentinel for tmux resumes without parsing Herdr placement", async () => {
		const dir = createTestDir();
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		const logFile = join(dir, "tmux.log");
		writeExecutable(
			binDir,
			"tmux",
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_TMUX_LOG"
case "$1" in
  new-window) printf '%%42\\n' ;;
esac
`,
		);
		const originalPath = process.env.PATH;
		const originalMux = process.env.PI_SUBAGENT_MUX;
		const originalTmux = process.env.TMUX;
		const originalTmuxLog = process.env.FAKE_TMUX_LOG;
		const originalPiCommand = process.env.PI_SUBAGENT_PI_COMMAND;
		const originalShell = process.env.SHELL;
		process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
		process.env.PI_SUBAGENT_MUX = "tmux";
		process.env.TMUX = "fake-tmux-socket";
		process.env.FAKE_TMUX_LOG = logFile;
		process.env.SHELL = "/bin/sh";
		try {
			const fakePi = writeExecutable(dir, "fake-pi", "#!/bin/sh\nexit 0\n");
			process.env.PI_SUBAGENT_PI_COMMAND = fakePiCommand(fakePi);
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({
					type: "session",
					version: 3,
					id: "child-session",
					timestamp: new Date().toISOString(),
					cwd: dir,
				}) + "\n",
			);
			await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "resume-child",
				agent: "scout",
				mode: "interactive",
				sessionMode: "fork",
				autoExit: true,
				parentClosePolicy: "terminate",
				blocking: false,
				async: true,
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: dir,
				cwd: dir,
				boundarySystemPrompt: false,
				env: "PI_SUBAGENT_HERDR_PLACEMENT=bogus",
			});

			const running = await resumeSubagentSession(
				{ sessionFile, task: "resume sentinel check" },
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
					runningSubagents: new Map<string, any>(),
				},
			);

			const log = readFileSync(logFile, "utf8");
			const commandMatch = log.match(/send-keys -t %42 -l ([\s\S]*?)\nsend-keys -t %42 Enter/);
			assert.ok(commandMatch?.[1], "expected tmux to receive a shell command");

			const shell = spawn("/bin/sh", [], {
				stdio: ["pipe", "ignore", "ignore"],
			});
			try {
				shell.stdin.write(`${commandMatch[1]}\n`);
				const sentinel = await readNonEmptyFileEventually(running.doneSentinelFile!);
				assert.match(sentinel, /__SUBAGENT_DONE_0__/);
			} finally {
				shell.stdin.end("exit\n");
			}
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalMux === undefined) delete process.env.PI_SUBAGENT_MUX;
			else process.env.PI_SUBAGENT_MUX = originalMux;
			if (originalTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = originalTmux;
			if (originalTmuxLog === undefined) delete process.env.FAKE_TMUX_LOG;
			else process.env.FAKE_TMUX_LOG = originalTmuxLog;
			if (originalPiCommand === undefined) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = originalPiCommand;
			if (originalShell === undefined) delete process.env.SHELL;
			else process.env.SHELL = originalShell;
		}
	});

	it("writes follow-up text to a resume artifact without trimming user content", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(
			sessionFile,
			JSON.stringify({
				type: "session",
				version: 3,
				id: "child-session",
				timestamp: new Date().toISOString(),
				cwd: dir,
			}) + "\n",
		);

		const task = "  preserve leading space\n\nand trailing space  \n";
		const artifactPath = writeResumeTaskArtifactForTest("resume-child", task, sessionFile, dir);

		assert.equal(readFileSync(artifactPath, "utf8"), task);
		assert.match(artifactPath, /child-session\/context\/resume-child-/);
	});

	it("sanitizes resumed session ids before using them in artifact paths", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(
			sessionFile,
			JSON.stringify({
				type: "session",
				version: 3,
				id: "../../evil/session",
				timestamp: new Date().toISOString(),
				cwd: dir,
			}) + "\n",
		);

		const artifactPath = writeResumeTaskArtifactForTest("resume-child", "safe", sessionFile, dir);

		assert.doesNotMatch(artifactPath, /\.\.\/\.\.\/evil\/session|evil\/session/);
		assert.match(artifactPath, /\.\.-\.\.-evil-session\/context\/resume-child-/);
	});

	it("expands follow-up task placeholders when original launch opted in", async () => {
		const dir = createTestDir();
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		const logFile = join(dir, "tmux.log");
		writeExecutable(
			binDir,
			"tmux",
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_TMUX_LOG"
case "$1" in
  new-window) printf '%%42\\n' ;;
esac
`,
		);
		process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
		process.env.PI_SUBAGENT_MUX = "tmux";
		process.env.TMUX = "fake-tmux-socket";
		process.env.FAKE_TMUX_LOG = logFile;

		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(
			sessionFile,
			JSON.stringify({
				type: "session",
				version: 3,
				id: "child-session",
				timestamp: new Date().toISOString(),
				cwd: dir,
			}) + "\n",
		);
		await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
			version: 1,
			timestamp: new Date().toISOString(),
			name: "resume-child",
			agent: "scout",
			mode: "interactive",
			sessionMode: "fork",
			autoExit: true,
			parentClosePolicy: "terminate",
			async: true,
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: dir,
			cwd: dir,
			boundarySystemPrompt: false,
			taskExpansion: "shell",
		});

		await resumeSubagentSession(
			{ sessionFile, task: "Follow-up marker: !`printf resume-marker`" },
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
				runningSubagents: new Map<string, any>(),
			},
		);

		const log = readFileSync(logFile, "utf8");
		const artifactPath = log.match(/@([^'\s]+child-session[^'\s]+)/)?.[1];
		assert.ok(artifactPath);
		const artifact = readFileSync(artifactPath, "utf8");
		assert.match(artifact, /Follow-up marker: resume-marker/);
		assert.doesNotMatch(artifact, /!`printf resume-marker`/);
	});

	it("expands follow-up task placeholders for background resumes", async () => {
		const dir = createTestDir();
		const stdinLog = join(dir, "stdin.log");
		const bin = writeExecutable(
			dir,
			"capture-pi",
			`#!/usr/bin/env bash
cat > '${stdinLog}'
`,
		);
		const originalCommand = process.env.PI_SUBAGENT_PI_COMMAND;
		process.env.PI_SUBAGENT_PI_COMMAND = fakePiCommand(bin);
		try {
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({
					type: "session",
					version: 3,
					id: "child-session",
					timestamp: new Date().toISOString(),
					cwd: dir,
				}) + "\n",
			);
			await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "resume-child",
				agent: "scout",
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
				taskExpansion: "shell",
			});

			await resumeSubagentSession(
				{ sessionFile, task: "Background marker: !`printf background-marker`" },
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
					runningSubagents: new Map<string, any>(),
				},
			);

			const stdin = await readNonEmptyFileEventually(stdinLog);
			assert.match(stdin, /Background marker: background-marker/);
			assert.doesNotMatch(stdin, /!`printf background-marker`/);
		} finally {
			if (originalCommand == null) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = originalCommand;
		}
	});

	it("passes follow-up task as an @artifact startup prompt instead of typing into the pane", async () => {
		const dir = createTestDir();
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		const logFile = join(dir, "tmux.log");
		writeExecutable(
			binDir,
			"tmux",
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_TMUX_LOG"
case "$1" in
  new-window) printf '%%42\\n' ;;
esac
`,
		);
		process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
		process.env.PI_SUBAGENT_MUX = "tmux";
		process.env.TMUX = "fake-tmux-socket";
		process.env.FAKE_TMUX_LOG = logFile;

		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(
			sessionFile,
			JSON.stringify({
				type: "session",
				version: 3,
				id: "child-session",
				timestamp: new Date().toISOString(),
				cwd: dir,
			}) + "\n",
		);
		await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
			version: 1,
			timestamp: new Date().toISOString(),
			name: "resume-child",
			agent: "scout",
			mode: "interactive",
			sessionMode: "fork",
			autoExit: true,
			parentClosePolicy: "terminate",
			blocking: false,
			async: true,
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: dir,
			cwd: dir,
			boundarySystemPrompt: false,
		});

		await resumeSubagentSession(
			{ sessionFile, task: "follow up\nwith newline" },
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
				runningSubagents: new Map<string, any>(),
			},
		);

		const log = readFileSync(logFile, "utf8");
		assert.match(log, /@.*child-session.*resume-child-/);
		assert.doesNotMatch(log, /send-keys -t %42 -l follow up/);
	});
});
