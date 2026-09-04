/**
 * The launch entry point of the run store. It makes a launch durable before
 * any process exists: the run record first, the writer guard next, then
 * either the queued marker (the pool is full) or the spawned marker and one
 * spawn through the process-launcher port.
 *
 * The writer guard permits at most one live run on one session, across
 * separate parent processes. The guard is one name-is-the-state file,
 * `writer--<runId>`, in the session's guard directory. The first run on a
 * session creates it; every later run must win the atomic rename from the
 * old run's name to its own. A launch that loses the rename settles its
 * own record as stopped and fails loudly.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	createExclusiveFile,
	ensureRunArtifactRoot,
	ensureRunProjectDir,
	OUTCOME_RECORD_NAME,
	readFrozenJson,
	StateSwapLostError,
	swapStateName,
	writeFrozenFile,
} from "./artifacts.ts";
import type { ProcessLauncherPort } from "./launcher-port.ts";
import {
	countProjectPoolRuns,
	QUEUED_MARKER_NAME,
	runDirPath,
	runsDirPath,
	SPAWNED_MARKER_NAME,
} from "./live-state.ts";
import { type RunRecord, type RunRecordFacts, readRunRecord, writeRunRecord } from "./record.ts";

/** The directory under one project dir that holds every session guard. */
export const SESSIONS_DIR_NAME = "sessions";

/** The writer guard file: this prefix plus the run id that holds the session. */
export const WRITER_GUARD_PREFIX = "writer--";

/** The observation log of one run, inside its run directory. */
export const OBSERVATION_LOG_NAME = "observation.log";

/** The session already has a live run, so this launch is refused. */
export class WriterGuardHeldError extends Error {
	constructor(sessionId: string, heldRunId: string) {
		super(
			`The session ${sessionId} already has a live run (${heldRunId}). ` +
				"One session can hold only one live run.",
		);
		this.name = "WriterGuardHeldError";
	}
}

/** A concurrent launch won the writer guard rename first. */
export class WriterGuardRaceError extends Error {
	constructor(sessionId: string) {
		super(`Another launch took the session ${sessionId} first.`);
		this.name = "WriterGuardRaceError";
	}
}

export interface RunLaunchRequest {
	/** The run artifact root that holds every project's run store. */
	runRoot: string;
	/** The launching parent's project root. It decides where the run lives. */
	projectRoot: string;
	facts: Omit<RunRecordFacts, "runId" | "createdAt">;
	/** The Pi child command. Its cwd comes from the launch shape in the facts. */
	process: { command: string; args: string[]; env: Record<string, string> };
	/** The project run-pool size. Null: no limit. */
	poolLimit: number | null;
}

export type RunLaunchResult =
	| { state: "queued"; record: RunRecord; runDir: string }
	| { state: "spawned"; record: RunRecord; runDir: string; wrapperPid: number | null };

export function sessionGuardDirPath(projectDir: string, sessionId: string): string {
	return join(projectDir, SESSIONS_DIR_NAME, sessionId.replace(/[/\\:]/g, "-"));
}

export function launchRun(
	launcher: ProcessLauncherPort,
	request: RunLaunchRequest,
	now: () => Date = () => new Date(),
): RunLaunchResult {
	ensureRunArtifactRoot(request.runRoot);
	const projectDir = ensureRunProjectDir(request.runRoot, request.projectRoot);
	mkdirSync(runsDirPath(projectDir), { recursive: true, mode: 0o700 });

	const session = request.facts.session;
	const sessionId = "id" in session ? session.id : null;
	let guardDir: string | null = null;
	let heldRunId: string | null = null;
	if (sessionId !== null) {
		guardDir = sessionGuardDirPath(projectDir, sessionId);
		mkdirSync(guardDir, { recursive: true, mode: 0o700 });
		heldRunId = peekWriterGuard(guardDir);
		if (heldRunId !== null && !runFreedItsSession(projectDir, heldRunId)) {
			throw new WriterGuardHeldError(sessionId, heldRunId);
		}
	}

	const createdAt = now().toISOString();
	const runId = `${createdAt.replace(/[-:.]/g, "")}-${randomBytes(4).toString("hex")}`;
	const runDir = runDirPath(projectDir, runId);
	mkdirSync(runDir, { mode: 0o700 });
	const record = writeRunRecord(runDir, { runId, createdAt, ...request.facts });

	if (guardDir !== null && sessionId !== null) {
		claimWriterGuard(guardDir, sessionId, heldRunId, runId, runDir, createdAt);
	}

	if (request.poolLimit !== null && countProjectPoolRuns(projectDir) >= request.poolLimit) {
		createExclusiveFile(join(runDir, QUEUED_MARKER_NAME));
		return { state: "queued", record, runDir };
	}

	createExclusiveFile(join(runDir, SPAWNED_MARKER_NAME));
	const handle = launcher.spawn({
		runDir,
		observationLogPath: join(runDir, OBSERVATION_LOG_NAME),
		command: request.process.command,
		args: request.process.args,
		cwd: request.facts.launch.cwd,
		env: request.process.env,
	});
	return { state: "spawned", record, runDir, wrapperPid: handle.wrapperPid };
}

function peekWriterGuard(guardDir: string): string | null {
	const holders = readdirSync(guardDir).filter((name) => name.startsWith(WRITER_GUARD_PREFIX));
	if (holders.length === 0) return null;
	if (holders.length > 1) {
		throw new Error(
			`The writer guard in ${guardDir} names more than one run ` +
				`(${holders.join(", ")}). Refusing to launch on a corrupt guard.`,
		);
	}
	return holders[0].slice(WRITER_GUARD_PREFIX.length);
}

/**
 * The held run no longer holds its session when it has an outcome record
 * (settled, or lost — #11 accepts a resume over a lost run), or when its
 * whole run directory is gone (retention deleted it).
 */
function runFreedItsSession(projectDir: string, heldRunId: string): boolean {
	const heldRunDir = runDirPath(projectDir, heldRunId);
	if (readRunRecord(heldRunDir) === null) return true;
	return readFrozenJson(join(heldRunDir, OUTCOME_RECORD_NAME)) !== null;
}

/**
 * Take the writer guard for the new run. The atomic rename is the race:
 * when the old name is already gone, a concurrent launch won, and this
 * launch settles its own fresh record as stopped before it fails.
 */
function claimWriterGuard(
	guardDir: string,
	sessionId: string,
	heldRunId: string | null,
	newRunId: string,
	newRunDir: string,
	at: string,
): void {
	if (heldRunId === null) {
		// The first run on a session: the session was just created by this
		// parent, so no other actor launches on it yet. Every later run
		// goes through the racing rename below.
		if (createExclusiveFile(join(guardDir, `${WRITER_GUARD_PREFIX}${newRunId}`))) return;
		settleStopped(newRunDir, "writer-guard-race", at);
		throw new WriterGuardRaceError(sessionId);
	}
	try {
		swapStateName(
			guardDir,
			`${WRITER_GUARD_PREFIX}${heldRunId}`,
			`${WRITER_GUARD_PREFIX}${newRunId}`,
		);
	} catch (error) {
		if (error instanceof StateSwapLostError) {
			settleStopped(newRunDir, "writer-guard-race", at);
			throw new WriterGuardRaceError(sessionId);
		}
		throw error;
	}
}

function settleStopped(runDir: string, reason: string, endedAt: string): void {
	writeFrozenFile(
		join(runDir, OUTCOME_RECORD_NAME),
		`${JSON.stringify({ class: "stopped", reason, endedAt })}\n`,
	);
}
