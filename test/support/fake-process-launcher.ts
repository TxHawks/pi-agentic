/**
 * The scripted fake adapter of the process-launcher port. It writes the
 * same durable artifacts as the real launch wrapper — the child identity
 * record, observation-log lines, and the exit record — but on the injected
 * fake clock, so timing tests never sleep.
 *
 * Signal fidelity mirrors the real wrapper: SIGTERM to the child settles it
 * with wait status 143 unless the script says the child ignores it; SIGKILL
 * always settles it with 137; SIGTERM to the wrapper is ignored (the trap);
 * SIGKILL to the wrapper loses the exit record while the child runs on.
 */
import { appendFileSync } from "node:fs";
import { basename, join } from "node:path";
import { writeFrozenFile } from "../../src/runs/artifacts.ts";
import type { IdentityToken } from "../../src/runs/identity.ts";
import type {
	ProcessLauncherPort,
	RunProcessHandle,
	RunSignal,
	RunSpawnRequest,
} from "../../src/runs/launcher-port.ts";
import { CHILD_IDENTITY_NAME, EXIT_RECORD_NAME } from "../../src/runs/wrapper.ts";
import type { FakeClock } from "./fake-clock.ts";

export interface FakeSignalReaction {
	/** Fake milliseconds between the signal and the exit record. Default 0. */
	afterMs?: number;
	waitStatus?: number;
	/** The child ignores the signal. SIGKILL cannot be ignored. */
	ignored?: boolean;
}

export interface FakeRunScript {
	/** When the child identity record appears. Default 0 (at spawn). False: never. */
	childIdentityAtMs?: number | false;
	childToken?: Partial<IdentityToken>;
	/** Null: the wrapper could not read its own identity. */
	wrapperToken?: Partial<IdentityToken> | null;
	/** Lines appended to the observation log at fake times. */
	events?: Array<{ atMs: number; line: string }>;
	/** When and how the child exits on its own. Default: runs until a signal. */
	exit?: { atMs: number; waitStatus: number };
	onSigterm?: FakeSignalReaction;
	onSigkill?: FakeSignalReaction;
}

export interface FakeRun {
	request: RunSpawnRequest;
	script: FakeRunScript;
	wrapperPid: number;
	childPid: number;
	childToken: IdentityToken;
	signals: Array<{ pid: number; signal: RunSignal }>;
	exited: boolean;
	wrapperKilled: boolean;
}

export class FakeProcessLauncher implements ProcessLauncherPort {
	readonly runs: FakeRun[] = [];
	private readonly scripts: FakeRunScript[] = [];
	private nextPid = 20001;
	private readonly clock: FakeClock;

	constructor(clock: FakeClock) {
		this.clock = clock;
	}

	/** Script the next spawn. Without a script, a spawn runs until a signal. */
	scriptNextRun(script: FakeRunScript): void {
		this.scripts.push(script);
	}

	spawn(request: RunSpawnRequest): RunProcessHandle {
		const script = this.scripts.shift() ?? {};
		const childPid = this.nextPid++;
		const wrapperPid = this.nextPid++;
		const run: FakeRun = {
			request,
			script,
			wrapperPid,
			childPid,
			childToken: {
				pid: childPid,
				startTime: `fake-start-${childPid}`,
				command: basename(request.command),
				...script.childToken,
			},
			signals: [],
			exited: false,
			wrapperKilled: false,
		};
		this.runs.push(run);
		appendFileSync(request.observationLogPath, "");

		if (script.childIdentityAtMs !== false) {
			this.clock.schedule(script.childIdentityAtMs ?? 0, () => {
				if (run.exited) return;
				this.writeChildIdentity(run);
			});
		}
		for (const event of script.events ?? []) {
			this.clock.schedule(event.atMs, () => {
				if (run.exited) return;
				appendFileSync(request.observationLogPath, `${event.line}\n`);
			});
		}
		if (script.exit) {
			const { atMs, waitStatus } = script.exit;
			this.clock.schedule(atMs, () => this.settle(run, waitStatus));
		}
		return { wrapperPid };
	}

	signal(pid: number, signal: RunSignal): boolean {
		const run = this.runs.find(
			(candidate) =>
				!candidate.exited && (candidate.childPid === pid || candidate.wrapperPid === pid),
		);
		if (!run || (run.wrapperKilled && run.wrapperPid === pid)) return false;
		run.signals.push({ pid, signal });

		if (run.wrapperPid === pid) {
			// The real wrapper traps SIGTERM; SIGKILL kills only the wrapper,
			// so the child runs on and the exit evidence is lost.
			if (signal === "SIGKILL") run.wrapperKilled = true;
			return true;
		}

		if (signal === "SIGTERM") {
			const reaction = run.script.onSigterm ?? {};
			if (reaction.ignored) return true;
			this.clock.schedule(reaction.afterMs ?? 0, () =>
				this.settle(run, reaction.waitStatus ?? 143),
			);
			return true;
		}
		const reaction = run.script.onSigkill ?? {};
		this.clock.schedule(reaction.afterMs ?? 0, () => this.settle(run, reaction.waitStatus ?? 137));
		return true;
	}

	private settle(run: FakeRun, waitStatus: number): void {
		if (run.exited) return;
		run.exited = true;
		if (run.wrapperKilled) return;
		// Whole seconds, the same precision as the real wrapper's `date -u`.
		const endedAt = `${new Date(this.clock.now()).toISOString().slice(0, 19)}Z`;
		writeFrozenFile(
			join(run.request.runDir, EXIT_RECORD_NAME),
			`${JSON.stringify({ waitStatus, endedAt })}\n`,
		);
	}

	private writeChildIdentity(run: FakeRun): void {
		const wrapper =
			run.script.wrapperToken === null
				? null
				: {
						pid: run.wrapperPid,
						startTime: `fake-start-${run.wrapperPid}`,
						command: "sh",
						...run.script.wrapperToken,
					};
		writeFrozenFile(
			join(run.request.runDir, CHILD_IDENTITY_NAME),
			`${JSON.stringify({ child: run.childToken, wrapper })}\n`,
		);
	}
}
