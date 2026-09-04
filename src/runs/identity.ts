import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Durable proof that a recorded process is still the run's own process.
 * The raw start time is an opaque text token: the tick count from
 * `/proc/<pid>/stat` on Linux, the `ps lstart` text elsewhere. It is
 * compared exactly and never parsed, so pid reuse cannot pass the check.
 */
export interface IdentityToken {
	pid: number;
	startTime: string;
	command: string;
}

export interface ProcessIdentity {
	startTime: string;
	command: string;
}

/**
 * The two OS questions behind the liveness check. "unknown" means the
 * probe itself failed; null from identity() means no such process.
 */
export interface ProcessProbe {
	exists(pid: number): boolean | "unknown";
	identity(pid: number): ProcessIdentity | null | "unknown";
}

export type LivenessCheck =
	| { verdict: "confirmed-live" }
	| { verdict: "confirmed-dead" }
	| {
			verdict: "unconfirmed";
			reason: "start-time-mismatch" | "command-mismatch" | "vanished" | "probe-error";
	  };

/**
 * The three-part liveness check: the process exists, the raw start time
 * matches exactly, and the command name matches. Only "confirmed-live"
 * permits a signal. Every mismatch or probe failure is "unconfirmed":
 * the caller sends no signal and classifies lost, which stays revisable.
 */
export function checkLiveness(token: IdentityToken, probe: ProcessProbe = osProbe): LivenessCheck {
	const exists = probe.exists(token.pid);
	if (exists === "unknown") return { verdict: "unconfirmed", reason: "probe-error" };
	if (!exists) return { verdict: "confirmed-dead" };
	const current = probe.identity(token.pid);
	if (current === "unknown") return { verdict: "unconfirmed", reason: "probe-error" };
	if (current === null) return { verdict: "unconfirmed", reason: "vanished" };
	if (current.startTime !== token.startTime) {
		return { verdict: "unconfirmed", reason: "start-time-mismatch" };
	}
	if (current.command !== token.command) {
		return { verdict: "unconfirmed", reason: "command-mismatch" };
	}
	return { verdict: "confirmed-live" };
}

/** Capture the identity token of a live process, or null when it cannot be read. */
export function captureIdentityToken(
	pid: number,
	probe: ProcessProbe = osProbe,
): IdentityToken | null {
	const identity = probe.identity(pid);
	if (identity === null || identity === "unknown") return null;
	return { pid, startTime: identity.startTime, command: identity.command };
}

const osProbe: ProcessProbe = {
	exists(pid) {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ESRCH") return false;
			// EPERM: the process exists but belongs to another user.
			if (code === "EPERM") return true;
			return "unknown";
		}
	},
	identity(pid) {
		return process.platform === "linux" ? readProcIdentity(pid) : readPsIdentity(pid);
	},
};

function readProcIdentity(pid: number): ProcessIdentity | null | "unknown" {
	let stat: string;
	try {
		stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ESRCH") return null;
		return "unknown";
	}
	// The command sits in parentheses and may itself hold spaces or a ")",
	// so the parse anchors on the last ")" in the line.
	const open = stat.indexOf("(");
	const close = stat.lastIndexOf(")");
	if (open < 0 || close < open) return "unknown";
	const command = stat.slice(open + 1, close);
	// After the ")" the fields are space-separated, starting at field 3.
	// Field 22 is the start time in raw clock ticks.
	const startTime = stat.slice(close + 2).split(" ")[19];
	if (!startTime) return "unknown";
	return { startTime, command };
}

function readPsIdentity(pid: number): ProcessIdentity | null | "unknown" {
	const startTime = readPsColumn(pid, "lstart=");
	if (startTime === null || startTime === "unknown") return startTime;
	const command = readPsColumn(pid, "comm=");
	if (command === null || command === "unknown") return command;
	return { startTime, command };
}

function readPsColumn(pid: number, format: string): string | null | "unknown" {
	const result = spawnSync("ps", ["-p", String(pid), "-o", format], { encoding: "utf8" });
	if (result.error) return "unknown";
	const text = (result.stdout ?? "").trim();
	if (result.status !== 0 || text === "") return null;
	return text;
}
