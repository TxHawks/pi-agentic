import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	captureIdentityToken,
	checkLiveness,
	type IdentityToken,
	type ProcessIdentity,
	type ProcessProbe,
} from "../../src/runs/identity.ts";
import { assert, describe, it } from "../support/index.ts";

const LIVE_IDENTITY: ProcessIdentity = { startTime: "1000", command: "pi" };

function fakeProbe(overrides: Partial<ProcessProbe>): ProcessProbe {
	return {
		exists: () => true,
		identity: () => LIVE_IDENTITY,
		...overrides,
	};
}

const RECORDED: IdentityToken = { pid: 4242, startTime: "1000", command: "pi" };

describe("identity token and liveness check", () => {
	it("captures pid, raw start time, and command name for a live process", () => {
		const token = captureIdentityToken(process.pid);

		assert.ok(token);
		assert.equal(token.pid, process.pid);
		assert.ok(token.startTime.length > 0);
		assert.ok(token.command.length > 0);
	});

	it("confirms the capturing process as live", () => {
		const token = captureIdentityToken(process.pid);

		assert.ok(token);
		assert.deepEqual(checkLiveness(token), { verdict: "confirmed-live" });
	});

	it("confirms a process dead after it exits", async () => {
		const child = spawn("sleep", ["60"]);
		assert.ok(child.pid);
		const token = captureIdentityToken(child.pid);
		assert.ok(token);
		assert.deepEqual(checkLiveness(token), { verdict: "confirmed-live" });

		child.kill("SIGKILL");
		await once(child, "exit");

		assert.deepEqual(checkLiveness(token), { verdict: "confirmed-dead" });
	});

	it("reports a start-time mismatch when the pid was reused", () => {
		const probe = fakeProbe({ identity: () => ({ startTime: "2000", command: "pi" }) });

		assert.deepEqual(checkLiveness(RECORDED, probe), {
			verdict: "unconfirmed",
			reason: "start-time-mismatch",
		});
	});

	it("reports a command mismatch when another program holds the pid", () => {
		const probe = fakeProbe({ identity: () => ({ startTime: "1000", command: "sshd" }) });

		assert.deepEqual(checkLiveness(RECORDED, probe), {
			verdict: "unconfirmed",
			reason: "command-mismatch",
		});
	});

	it("confirms dead when the process does not exist", () => {
		const probe = fakeProbe({ exists: () => false });

		assert.deepEqual(checkLiveness(RECORDED, probe), { verdict: "confirmed-dead" });
	});

	it("stays unconfirmed when a probe cannot answer", () => {
		assert.deepEqual(checkLiveness(RECORDED, fakeProbe({ exists: () => "unknown" })), {
			verdict: "unconfirmed",
			reason: "probe-error",
		});
		assert.deepEqual(checkLiveness(RECORDED, fakeProbe({ identity: () => "unknown" })), {
			verdict: "unconfirmed",
			reason: "probe-error",
		});
	});

	it("stays unconfirmed when the process vanishes between the two probes", () => {
		const probe = fakeProbe({ identity: () => null });

		assert.deepEqual(checkLiveness(RECORDED, probe), {
			verdict: "unconfirmed",
			reason: "vanished",
		});
	});

	it("treats a permission error on the existence probe as an existing process", () => {
		// kill(pid, 0) answers EPERM for another user's process. The process
		// exists, so the check must go on to the identity comparison.
		const init = captureIdentityToken(1);
		if (!init) return; // some sandboxes hide pid 1; nothing to assert then
		const result = checkLiveness({ pid: 1, startTime: "not-real", command: init.command });
		assert.deepEqual(result, { verdict: "unconfirmed", reason: "start-time-mismatch" });
	});
});
