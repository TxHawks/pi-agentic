/**
 * The one real seam of the run store: the process-launcher port. It has
 * exactly two adapters — this production adapter on node:child_process,
 * and the scripted fake in test/support/fake-process-launcher.ts. Every
 * unit and integration test runs on the fake.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { launchWrapperCommand } from "./wrapper.ts";

/** One spawn of a run's child process, wrapped by the launch wrapper. */
export interface RunSpawnRequest {
	runDir: string;
	observationLogPath: string;
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
}

/** What a spawn returns. A null pid means the spawn failed at once. */
export interface RunProcessHandle {
	wrapperPid: number | null;
}

export type RunSignal = "SIGTERM" | "SIGKILL";

/**
 * Spawn with file-descriptor redirect, and signal. Signals aim at one pid,
 * never at a process group. `signal` reports false when no process has the
 * pid; the caller has already run the liveness check, so false is evidence,
 * not an error.
 */
export interface ProcessLauncherPort {
	spawn(request: RunSpawnRequest): RunProcessHandle;
	signal(pid: number, signal: RunSignal): boolean;
}

/**
 * The production adapter. The child's stdout and stderr are redirected into
 * the observation log by file descriptor at spawn: the OS owns the writes,
 * so no pipe, no pump, and no live process stands between the child and its
 * log. The wrapper is detached as its own group leader and unref'd, so it
 * outlives this process.
 */
export function createProcessLauncher(): ProcessLauncherPort {
	return {
		spawn(request) {
			const logFd = openSync(request.observationLogPath, "a", 0o600);
			try {
				const wrapper = launchWrapperCommand(request.runDir, request.command, request.args);
				const child = spawn(wrapper.command, wrapper.args, {
					cwd: request.cwd,
					env: request.env,
					detached: true,
					stdio: ["ignore", logFd, logFd],
				});
				// A spawn failure surfaces only on this event. Nobody listens
				// past the no-op: a failed spawn leaves a run with no child
				// identity, and the spawn grace classifies it lost, durably.
				child.on("error", () => {});
				child.unref();
				return { wrapperPid: child.pid ?? null };
			} finally {
				closeSync(logFd);
			}
		},
		signal(pid, signal) {
			try {
				process.kill(pid, signal);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
				throw error;
			}
		},
	};
}
