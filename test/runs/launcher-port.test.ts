import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createProcessLauncher, type RunSpawnRequest } from "../../src/runs/launcher-port.ts";
import { EXIT_RECORD_NAME, readChildIdentity, readExitRecord } from "../../src/runs/wrapper.ts";
import { FakeClock } from "../support/fake-clock.ts";
import { FakeProcessLauncher } from "../support/fake-process-launcher.ts";
import {
	after,
	assert,
	before,
	createTestDir,
	describe,
	it,
	join,
	mkdirSync,
	readFileSync,
	rmSync,
	sleep,
} from "../support/index.ts";

function requestFactory() {
	let dir: string;
	let runCount = 0;
	before(() => {
		dir = createTestDir();
	});
	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});
	return function freshRequest(command: string, args: string[]): RunSpawnRequest {
		runCount += 1;
		const runDir = join(dir, `run-${runCount}`);
		mkdirSync(runDir);
		return {
			runDir,
			observationLogPath: join(runDir, "observation.log"),
			command,
			args,
			cwd: runDir,
			env: { ...process.env } as Record<string, string>,
		};
	};
}

describe("production process launcher", () => {
	const launcher = createProcessLauncher();
	const freshRequest = requestFactory();

	async function waitForExitRecord(runDir: string): Promise<void> {
		for (let attempt = 0; attempt < 400; attempt++) {
			if (readExitRecord(runDir) !== null) return;
			await sleep(10);
		}
		throw new Error(`Timed out waiting for ${EXIT_RECORD_NAME} in ${runDir}`);
	}

	it("spawns the wrapper detached and redirects output into the log by file descriptor", async () => {
		const request = freshRequest("/bin/sh", ["-c", "echo from-child; sleep 0.3"]);

		const handle = launcher.spawn(request);

		assert.ok(handle.wrapperPid);
		await waitForExitRecord(request.runDir);
		assert.match(readFileSync(request.observationLogPath, "utf8"), /from-child/);
		assert.ok(readChildIdentity(request.runDir));
		assert.equal(readExitRecord(request.runDir)?.waitStatus, 0);
	});

	it("runs the child in the requested working directory", async () => {
		const request = freshRequest("/bin/sh", ["-c", "pwd"]);

		launcher.spawn(request);

		await waitForExitRecord(request.runDir);
		assert.match(readFileSync(request.observationLogPath, "utf8"), new RegExp(request.runDir));
	});

	it("delivers a signal to one live pid and reports false after the process ends", async () => {
		const child = spawn("sleep", ["60"]);
		assert.ok(child.pid);

		assert.equal(launcher.signal(child.pid, "SIGTERM"), true);
		await once(child, "exit");

		assert.equal(launcher.signal(child.pid, "SIGTERM"), false);
	});
});

describe("scripted fake process launcher", () => {
	const freshRequest = requestFactory();

	function freshFake(): { clock: FakeClock; fake: FakeProcessLauncher } {
		const clock = new FakeClock();
		return { clock, fake: new FakeProcessLauncher(clock) };
	}

	it("records the spawn request and creates the observation log", () => {
		const { fake } = freshFake();
		const request = freshRequest("pi", ["-p", "--mode", "json"]);

		const handle = fake.spawn(request);

		assert.ok(handle.wrapperPid);
		assert.equal(fake.runs.length, 1);
		assert.equal(fake.runs[0].request, request);
		assert.ok(existsSync(request.observationLogPath));
	});

	it("writes a child identity record at spawn that names distinct pids", () => {
		const { fake } = freshFake();
		const request = freshRequest("pi", []);

		fake.spawn(request);

		const identity = readChildIdentity(request.runDir);
		assert.ok(identity);
		assert.equal(identity.child.command, "pi");
		assert.ok(identity.wrapper);
		assert.notEqual(identity.wrapper.pid, identity.child.pid);
	});

	it("scripts the child identity: a later time, an own token, and never", () => {
		const { clock, fake } = freshFake();
		const late = freshRequest("pi", []);
		fake.scriptNextRun({
			childIdentityAtMs: 50,
			childToken: { startTime: "12345", command: "pi-custom" },
			wrapperToken: null,
		});
		fake.spawn(late);
		assert.equal(readChildIdentity(late.runDir), null);
		clock.advance(50);
		const identity = readChildIdentity(late.runDir);
		assert.ok(identity);
		assert.equal(identity.child.startTime, "12345");
		assert.equal(identity.child.command, "pi-custom");
		assert.equal(identity.wrapper, null);

		const never = freshRequest("pi", []);
		fake.scriptNextRun({ childIdentityAtMs: false, exit: { atMs: 10, waitStatus: 0 } });
		fake.spawn(never);
		clock.advance(100);
		assert.equal(readChildIdentity(never.runDir), null);
		assert.ok(readExitRecord(never.runDir));
	});

	it("emits scripted event lines on the fake clock, and none after the exit", () => {
		const { clock, fake } = freshFake();
		const request = freshRequest("pi", []);
		fake.scriptNextRun({
			events: [
				{ atMs: 100, line: '{"type":"turn_start"}' },
				{ atMs: 250, line: '{"type":"turn_end"}' },
				{ atMs: 900, line: '{"type":"after-death"}' },
			],
			exit: { atMs: 300, waitStatus: 0 },
		});
		fake.spawn(request);

		clock.advance(100);
		assert.equal(readFileSync(request.observationLogPath, "utf8"), '{"type":"turn_start"}\n');
		clock.advance(1000);
		assert.equal(
			readFileSync(request.observationLogPath, "utf8"),
			'{"type":"turn_start"}\n{"type":"turn_end"}\n',
		);
	});

	it("writes the exit record at the scripted time, stamped from the fake clock", () => {
		const { clock, fake } = freshFake();
		const request = freshRequest("pi", []);
		fake.scriptNextRun({ exit: { atMs: 300, waitStatus: 17 } });
		fake.spawn(request);

		clock.advance(299);
		assert.equal(readExitRecord(request.runDir), null);
		clock.advance(1);
		assert.deepEqual(readExitRecord(request.runDir), {
			waitStatus: 17,
			endedAt: new Date(300).toISOString(),
		});
	});

	it("settles a SIGTERM to the child with 143 by default, then the pid is gone", () => {
		const { fake } = freshFake();
		const request = freshRequest("pi", []);
		fake.spawn(request);
		const childPid = fake.runs[0].childPid;

		assert.equal(fake.signal(childPid, "SIGTERM"), true);
		assert.equal(readExitRecord(request.runDir)?.waitStatus, 143);
		assert.equal(fake.signal(childPid, "SIGTERM"), false);
	});

	it("honors a scripted stop escalation: TERM ignored, KILL settles with 137", () => {
		const { clock, fake } = freshFake();
		const request = freshRequest("pi", []);
		fake.scriptNextRun({ onSigterm: { ignored: true }, onSigkill: { afterMs: 20 } });
		fake.spawn(request);
		const childPid = fake.runs[0].childPid;

		assert.equal(fake.signal(childPid, "SIGTERM"), true);
		clock.advance(500);
		assert.equal(readExitRecord(request.runDir), null);

		assert.equal(fake.signal(childPid, "SIGKILL"), true);
		clock.advance(19);
		assert.equal(readExitRecord(request.runDir), null);
		clock.advance(1);
		assert.equal(readExitRecord(request.runDir)?.waitStatus, 137);
	});

	it("delays a scripted SIGTERM reaction on the fake clock", () => {
		const { clock, fake } = freshFake();
		const request = freshRequest("pi", []);
		fake.scriptNextRun({ onSigterm: { afterMs: 500, waitStatus: 143 } });
		fake.spawn(request);

		fake.signal(fake.runs[0].childPid, "SIGTERM");
		clock.advance(499);
		assert.equal(readExitRecord(request.runDir), null);
		clock.advance(1);
		assert.equal(readExitRecord(request.runDir)?.waitStatus, 143);
	});

	it("ignores a SIGTERM aimed at the wrapper, like the real trap", () => {
		const { clock, fake } = freshFake();
		const request = freshRequest("pi", []);
		fake.scriptNextRun({ exit: { atMs: 100, waitStatus: 0 } });
		fake.spawn(request);

		assert.equal(fake.signal(fake.runs[0].wrapperPid, "SIGTERM"), true);
		clock.advance(100);
		assert.equal(readExitRecord(request.runDir)?.waitStatus, 0);
	});

	it("loses the exit record when the wrapper is SIGKILLed, while the child runs on", () => {
		const { clock, fake } = freshFake();
		const request = freshRequest("pi", []);
		fake.scriptNextRun({
			events: [{ atMs: 50, line: "still-working" }],
			exit: { atMs: 100, waitStatus: 0 },
		});
		fake.spawn(request);
		const run = fake.runs[0];

		assert.equal(fake.signal(run.wrapperPid, "SIGKILL"), true);
		clock.advance(200);

		assert.match(readFileSync(request.observationLogPath, "utf8"), /still-working/);
		assert.equal(readExitRecord(request.runDir), null);
		assert.equal(fake.signal(run.wrapperPid, "SIGKILL"), false);
	});

	it("reports false for a pid no fake process has", () => {
		const { fake } = freshFake();

		assert.equal(fake.signal(99999, "SIGTERM"), false);
	});
});
