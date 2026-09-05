/**
 * The durable live-state model of the run store. A run's state is read
 * from its artifacts alone — no in-memory counter, no reservation, no
 * rollback bookkeeping. The two count queries here replace the old
 * in-memory width counter:
 *
 * - A run counts against its owner until a final outcome exists. Queued,
 *   launching, running, ended-but-not-settled, and lost runs all count;
 *   settled runs do not.
 * - A run takes a place in the project run pool while it may have a live
 *   process: a spawn was issued, no exit record exists yet, and no outcome
 *   exists other than a revisable lost.
 */
import { type Dirent, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { OUTCOME_RECORD_NAME, readFrozenJson } from "./artifacts.ts";
import { readRunRecord } from "./record.ts";
import { EXIT_RECORD_NAME } from "./wrapper.ts";

/** The directory under one project dir that holds every run directory. */
const RUNS_DIR_NAME = "runs";

/** Name-is-the-state marker: the run is accepted and waits for a pool place. */
export const QUEUED_MARKER_NAME = "launch--queued";

/** Name-is-the-state marker: a spawn was issued for this run. */
export const SPAWNED_MARKER_NAME = "launch--spawned";

export function runsDirPath(projectDir: string): string {
	return join(projectDir, RUNS_DIR_NAME);
}

export function runDirPath(projectDir: string, runId: string): string {
	return join(runsDirPath(projectDir), runId);
}

/** Count the live runs that one owner session holds in one project. */
export function countSessionLiveRuns(projectDir: string, ownerSessionId: string): number {
	let count = 0;
	for (const runDir of listRunDirs(projectDir)) {
		const record = readRunRecord(runDir);
		if (record === null || record.parent.sessionId !== ownerSessionId) continue;
		if (hasNoFinalOutcome(runDir)) count += 1;
	}
	return count;
}

/** Count the runs that take a place in the project's run pool. */
export function countProjectPoolRuns(projectDir: string): number {
	let count = 0;
	for (const runDir of listRunDirs(projectDir)) {
		if (readRunRecord(runDir) === null) continue;
		if (!existsSync(join(runDir, SPAWNED_MARKER_NAME))) continue;
		if (existsSync(join(runDir, EXIT_RECORD_NAME))) continue;
		if (hasNoFinalOutcome(runDir)) count += 1;
	}
	return count;
}

/** A lost outcome is revisable, so the run still counts as live. */
function hasNoFinalOutcome(runDir: string): boolean {
	const outcome = readFrozenJson(join(runDir, OUTCOME_RECORD_NAME)) as { class?: unknown } | null;
	return outcome === null || outcome.class === "lost";
}

function listRunDirs(projectDir: string): string[] {
	const runsDir = runsDirPath(projectDir);
	let entries: Dirent[];
	try {
		entries = readdirSync(runsDir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return entries.filter((entry) => entry.isDirectory()).map((entry) => join(runsDir, entry.name));
}
