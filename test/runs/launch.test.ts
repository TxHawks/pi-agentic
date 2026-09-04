import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	OUTCOME_RECORD_NAME,
	readFrozenJson,
	runProjectDirName,
	writeFrozenFile,
} from "../../src/runs/artifacts.ts";
import {
	launchRun,
	OBSERVATION_LOG_NAME,
	type RunLaunchRequest,
	SESSIONS_DIR_NAME,
	sessionGuardDirPath,
	WRITER_GUARD_PREFIX,
	WriterGuardHeldError,
	WriterGuardRaceError,
} from "../../src/runs/launch.ts";
import type { ProcessLauncherPort, RunSpawnRequest } from "../../src/runs/launcher-port.ts";
import {
	countSessionLiveRuns,
	QUEUED_MARKER_NAME,
	runsDirPath,
	SPAWNED_MARKER_NAME,
} from "../../src/runs/live-state.ts";
import { type RunRecord, type RunSessionRef, readRunRecord } from "../../src/runs/record.ts";
import { FakeClock } from "../support/fake-clock.ts";
import { FakeProcessLauncher } from "../support/fake-process-launcher.ts";
import { after, assert, before, createTestDir, describe, it, rmSync } from "../support/index.ts";

const PROJECT_ROOT = "/tmp/alpha/proj";

function request(
	root: string,
	overrides?: {
		sessionId?: string;
		session?: RunSessionRef;
		resumeOf?: string | null;
		poolLimit?: number | null;
	},
): RunLaunchRequest {
	const sessionId = overrides?.sessionId ?? "child-session-a";
	return {
		runRoot: root,
		projectRoot: PROJECT_ROOT,
		facts: {
			session: overrides?.session ?? { file: `/sessions/${sessionId}.jsonl`, id: sessionId },
			resumeOf: overrides?.resumeOf ?? null,
			parent: {
				sessionId: "parent-session",
				process: { pid: 4242, startTime: "1000", command: "pi" },
			},
			launch: {
				agent: "scout",
				mode: "background",
				cwd: "/tmp/alpha/proj",
				timeoutSeconds: 600,
				idleTimeoutSeconds: null,
				timeoutWarnThreshold: null,
				onTimeout: "report",
				contextWarnAt: [],
			},
			piVersion: "0.85.0",
		},
		process: {
			command: "/usr/local/bin/pi",
			args: ["--mode", "json"],
			env: { PI_TEST: "1" },
		},
		poolLimit: overrides?.poolLimit === undefined ? null : overrides.poolLimit,
	};
}

describe("run store launch entry", () => {
	let dir: string;
	let root: string;
	let projectDir: string;
	let clock: FakeClock;
	let launcher: FakeProcessLauncher;
	let port: ProcessLauncherPort;
	let recordAtSpawn: RunRecord | null | undefined;
	let rootCount = 0;

	before(() => {
		dir = createTestDir();
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function freshStore(): void {
		rootCount += 1;
		root = join(dir, `root-${rootCount}`);
		projectDir = join(root, runProjectDirName(PROJECT_ROOT));
		clock = new FakeClock();
		launcher = new FakeProcessLauncher(clock);
		recordAtSpawn = undefined;
		port = {
			spawn(spawnRequest: RunSpawnRequest) {
				recordAtSpawn = readRunRecord(spawnRequest.runDir);
				return launcher.spawn(spawnRequest);
			},
			signal(pid, signal) {
				return launcher.signal(pid, signal);
			},
		};
	}

	function guardEntries(sessionId: string): string[] {
		return readdirSync(sessionGuardDirPath(projectDir, sessionId));
	}

	it("writes the run record on disk before the process exists", () => {
		freshStore();

		const result = launchRun(port, request(root));

		assert.equal(result.state, "spawned");
		assert.ok(recordAtSpawn, "the record must exist when the port spawns");
		assert.equal(recordAtSpawn?.runId, result.record.runId);
		assert.deepEqual(readRunRecord(result.runDir), result.record);
	});

	it("spawns through the port with the run directory, log path, and child command", () => {
		freshStore();

		const result = launchRun(port, request(root));

		assert.equal(result.state, "spawned");
		assert.equal(launcher.runs.length, 1);
		const spawned = launcher.runs[0].request;
		assert.equal(spawned.runDir, result.runDir);
		assert.equal(spawned.observationLogPath, join(result.runDir, OBSERVATION_LOG_NAME));
		assert.equal(spawned.command, "/usr/local/bin/pi");
		assert.deepEqual(spawned.args, ["--mode", "json"]);
		assert.equal(spawned.cwd, "/tmp/alpha/proj");
		assert.deepEqual(spawned.env, { PI_TEST: "1" });
		assert.ok(result.wrapperPid !== null);
		assert.ok(existsSync(join(result.runDir, SPAWNED_MARKER_NAME)));
		assert.equal(result.runDir, join(runsDirPath(projectDir), result.record.runId));
	});

	it("queues the launch when the project pool is full: a durable record, no process", () => {
		freshStore();
		launchRun(port, request(root, { sessionId: "child-a", poolLimit: 1 }));

		const result = launchRun(port, request(root, { sessionId: "child-b", poolLimit: 1 }));

		assert.equal(result.state, "queued");
		assert.equal(launcher.runs.length, 1);
		assert.ok(existsSync(join(result.runDir, QUEUED_MARKER_NAME)));
		assert.ok(!existsSync(join(result.runDir, SPAWNED_MARKER_NAME)));
		assert.deepEqual(readRunRecord(result.runDir), result.record);
	});

	it("does not count a queued run against the project pool", () => {
		freshStore();
		launchRun(port, request(root, { sessionId: "child-a", poolLimit: 1 }));
		launchRun(port, request(root, { sessionId: "child-b", poolLimit: 1 }));

		const result = launchRun(port, request(root, { sessionId: "child-c", poolLimit: 2 }));

		assert.equal(result.state, "spawned");
		assert.equal(launcher.runs.length, 2);
	});

	it("frees a pool place when a run's process ends", () => {
		freshStore();
		launcher.scriptNextRun({ exit: { atMs: 0, waitStatus: 0 } });
		launchRun(port, request(root, { sessionId: "child-a", poolLimit: 1 }));

		const result = launchRun(port, request(root, { sessionId: "child-b", poolLimit: 1 }));

		assert.equal(result.state, "spawned");
	});

	it("refuses a second live run on one session, before it writes any artifact", () => {
		freshStore();
		launchRun(port, request(root, { sessionId: "child-a" }));

		assert.throws(
			() => launchRun(port, request(root, { sessionId: "child-a" })),
			WriterGuardHeldError,
		);
		assert.equal(readdirSync(runsDirPath(projectDir)).length, 1);
		assert.equal(launcher.runs.length, 1);
	});

	it("a queued run holds the writer guard", () => {
		freshStore();
		const queued = launchRun(port, request(root, { sessionId: "child-a", poolLimit: 0 }));

		assert.equal(queued.state, "queued");
		assert.throws(
			() => launchRun(port, request(root, { sessionId: "child-a" })),
			WriterGuardHeldError,
		);
	});

	it("moves the writer guard to the new run when the old run has an outcome", () => {
		freshStore();
		const first = launchRun(port, request(root, { sessionId: "child-a" }));
		writeFrozenFile(join(first.runDir, OUTCOME_RECORD_NAME), '{"class":"completed"}\n');

		const second = launchRun(port, request(root, { sessionId: "child-a" }));

		assert.equal(second.state, "spawned");
		assert.deepEqual(guardEntries("child-a"), [`${WRITER_GUARD_PREFIX}${second.record.runId}`]);
	});

	it("stores resume lineage and never reads the old run record", () => {
		freshStore();
		const first = launchRun(port, request(root, { sessionId: "child-a" }));
		rmSync(first.runDir, { recursive: true, force: true });

		const second = launchRun(
			port,
			request(root, { sessionId: "child-a", resumeOf: first.record.runId }),
		);

		assert.equal(second.state, "spawned");
		assert.equal(second.record.resumeOf, first.record.runId);
		assert.deepEqual(guardEntries("child-a"), [`${WRITER_GUARD_PREFIX}${second.record.runId}`]);
	});

	it("the guard race has exactly one winner and the loser fails loudly", () => {
		freshStore();
		const first = launchRun(port, request(root, { sessionId: "child-a" }));
		writeFrozenFile(join(first.runDir, OUTCOME_RECORD_NAME), '{"class":"completed"}\n');
		const guardDir = sessionGuardDirPath(projectDir, "child-a");
		// The rival wins the rename inside this launch's window: the hooked
		// clock runs after the guard peek and before the guard claim.
		let rivalRan = false;
		const now = () => {
			if (!rivalRan) {
				rivalRan = true;
				mkdirSync(guardDir, { recursive: true });
				rmSync(join(guardDir, `${WRITER_GUARD_PREFIX}${first.record.runId}`));
				writeFrozenFile(join(guardDir, `${WRITER_GUARD_PREFIX}rival`), "");
			}
			return new Date("2026-09-05T08:00:00.000Z");
		};

		assert.throws(
			() => launchRun(port, request(root, { sessionId: "child-a" }), now),
			WriterGuardRaceError,
		);

		assert.deepEqual(guardEntries("child-a"), [`${WRITER_GUARD_PREFIX}rival`]);
		const runIds = readdirSync(runsDirPath(projectDir));
		const loserId = runIds.find((id) => id !== first.record.runId);
		assert.ok(loserId, "the loser leaves a settled record behind");
		const outcome = readFrozenJson(
			join(runsDirPath(projectDir), loserId as string, OUTCOME_RECORD_NAME),
		) as { class: string; reason: string };
		assert.equal(outcome.class, "stopped");
		assert.equal(outcome.reason, "writer-guard-race");
		assert.equal(countSessionLiveRuns(projectDir, "parent-session"), 0);
		assert.equal(launcher.runs.length, 1);
	});

	it("a no-session launch skips the writer guard", () => {
		freshStore();

		const first = launchRun(port, request(root, { session: { noSession: true } }));
		const second = launchRun(port, request(root, { session: { noSession: true } }));

		assert.equal(first.state, "spawned");
		assert.equal(second.state, "spawned");
		assert.notEqual(first.record.runId, second.record.runId);
		assert.ok(!existsSync(join(projectDir, SESSIONS_DIR_NAME)));
	});
});
