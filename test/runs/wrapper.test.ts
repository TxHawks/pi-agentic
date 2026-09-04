import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, openSync, readdirSync } from "node:fs";
import { checkLiveness } from "../../src/runs/identity.ts";
import {
	CHILD_IDENTITY_NAME,
	EXIT_RECORD_NAME,
	launchWrapperCommand,
	readChildIdentity,
	readExitRecord,
} from "../../src/runs/wrapper.ts";
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

// The wrapper's real signal behavior against a real Pi child is proven only
// by the Tier B live probes. These tests prove the script's record writes,
// the wait-status capture, and the output redirect, with plain sh children.
describe("launch wrapper script", () => {
	let dir: string;
	let runCount = 0;
	const strays: ChildProcess[] = [];

	before(() => {
		dir = createTestDir();
	});

	after(() => {
		for (const stray of strays) stray.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	});

	function freshRunDir(): string {
		runCount += 1;
		const runDir = join(dir, `run-${runCount}`);
		mkdirSync(runDir);
		return runDir;
	}

	function startWrapper(runDir: string, command: string, args: string[]): ChildProcess {
		const logFd = openSync(join(runDir, "observation.log"), "a");
		try {
			const wrapper = launchWrapperCommand(runDir, command, args);
			const child = spawn(wrapper.command, wrapper.args, {
				stdio: ["ignore", logFd, logFd],
			});
			strays.push(child);
			return child;
		} finally {
			closeSync(logFd);
		}
	}

	async function waitFor<T>(read: () => T | null, what: string): Promise<T> {
		for (let attempt = 0; attempt < 400; attempt++) {
			const value = read();
			if (value !== null) return value;
			await sleep(10);
		}
		throw new Error(`Timed out waiting for ${what}`);
	}

	it("records the child identity token and the exit record for a clean exit", async () => {
		const runDir = freshRunDir();
		// The child must live past the identity capture; a real Pi child always
		// does. An instant exit is the no-identity case, tested further down.
		const wrapper = startWrapper(runDir, "/bin/sh", ["-c", "sleep 0.3; exit 0"]);
		await once(wrapper, "exit");

		const identity = readChildIdentity(runDir);
		assert.ok(identity);
		assert.ok(identity.child.pid > 0);
		assert.ok(identity.child.startTime.length > 0);
		assert.ok(identity.child.command.length > 0);
		assert.ok(identity.wrapper);
		assert.ok(identity.wrapper.pid > 0);
		assert.notEqual(identity.wrapper.pid, identity.child.pid);

		const exit = readExitRecord(runDir);
		assert.ok(exit);
		assert.equal(exit.waitStatus, 0);
		assert.match(exit.endedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
	});

	it("leaves no temp file behind: both records appear whole or not at all", async () => {
		const runDir = freshRunDir();
		const wrapper = startWrapper(runDir, "/bin/sh", ["-c", "sleep 0.3; exit 0"]);
		await once(wrapper, "exit");

		assert.deepEqual(readdirSync(runDir).sort(), [
			CHILD_IDENTITY_NAME,
			EXIT_RECORD_NAME,
			"observation.log",
		]);
	});

	it("records the raw wait status of a failing child", async () => {
		const runDir = freshRunDir();
		const wrapper = startWrapper(runDir, "/bin/sh", ["-c", "exit 7"]);
		await once(wrapper, "exit");

		assert.equal(readExitRecord(runDir)?.waitStatus, 7);
	});

	it("sends child stdout and stderr into the observation log by file descriptor", async () => {
		const runDir = freshRunDir();
		const wrapper = startWrapper(runDir, "/bin/sh", ["-c", "echo line-out; echo line-err >&2"]);
		await once(wrapper, "exit");

		const log = readFileSync(join(runDir, "observation.log"), "utf8");
		assert.match(log, /line-out/);
		assert.match(log, /line-err/);
	});

	it("captures an identity that passes the liveness check, and a TERM reaches the child", async () => {
		const runDir = freshRunDir();
		const wrapper = startWrapper(runDir, "/bin/sh", ["-c", "sleep 30"]);

		const identity = await waitFor(() => readChildIdentity(runDir), CHILD_IDENTITY_NAME);
		assert.deepEqual(checkLiveness(identity.child), { verdict: "confirmed-live" });

		// The child must not inherit the wrapper's ignored SIGTERM, so a
		// plain TERM must end it with wait status 128 + 15.
		process.kill(identity.child.pid, "SIGTERM");
		await once(wrapper, "exit");

		assert.equal(readExitRecord(runDir)?.waitStatus, 143);
		assert.deepEqual(checkLiveness(identity.child), { verdict: "confirmed-dead" });
	});

	it("ignores a SIGTERM aimed at the wrapper and still writes the exit record", async () => {
		const runDir = freshRunDir();
		const wrapper = startWrapper(runDir, "/bin/sh", ["-c", "sleep 0.4; exit 5"]);
		await waitFor(() => readChildIdentity(runDir), CHILD_IDENTITY_NAME);

		assert.ok(wrapper.pid);
		process.kill(wrapper.pid, "SIGTERM");
		await once(wrapper, "exit");

		assert.equal(readExitRecord(runDir)?.waitStatus, 5);
	});

	it("writes the exit record without a child identity when the child dies at once", async () => {
		const runDir = freshRunDir();
		const wrapper = startWrapper(runDir, join(runDir, "no-such-command"), []);
		await once(wrapper, "exit");

		const exit = await waitFor(() => readExitRecord(runDir), EXIT_RECORD_NAME);
		assert.notEqual(exit.waitStatus, 0);
	});

	it("reads null for both records when the wrapper has not written them", () => {
		const runDir = freshRunDir();

		assert.equal(readChildIdentity(runDir), null);
		assert.equal(readExitRecord(runDir), null);
	});
});
