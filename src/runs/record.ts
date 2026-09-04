import { join } from "node:path";
import { RUN_STORE_FORMAT_VERSION, readFrozenJson, writeFrozenFile } from "./artifacts.ts";
import type { IdentityToken } from "./identity.ts";

/** The run record of one run, inside its run directory. */
export const RUN_RECORD_NAME = "record.json";

/** The Pi session a run writes to, or the no-session flag. */
export type RunSessionRef = { file: string; id: string } | { noSession: true };

/** The launch shape of one run: how it was started, with its budgets. */
export interface RunLaunchShape {
	agent: string;
	mode: "background" | "interactive";
	cwd: string;
	/** Whole-run time budget, in seconds. Null: no limit. */
	timeoutSeconds: number | null;
	/** Budget for time without output, in seconds. Null: no limit. */
	idleTimeoutSeconds: number | null;
	/** Percentage of a time budget at which the wrap-up starts. Null: default. */
	timeoutWarnThreshold: number | null;
	onTimeout: "report" | "block-resume" | null;
	/** The warning schedule: ascending absolute token counts. Empty: no warnings. */
	contextWarnAt: number[];
}

/**
 * The pre-spawn facts of one run. Everything here is known before the
 * process exists, and nothing here changes after the write.
 */
export interface RunRecordFacts {
	runId: string;
	createdAt: string;
	session: RunSessionRef;
	resumeOf: string | null;
	parent: { sessionId: string; process: IdentityToken };
	launch: RunLaunchShape;
	piVersion: string;
}

export interface RunRecord extends RunRecordFacts {
	formatVersion: number;
}

/**
 * Write the frozen run record. The record is written once, before the
 * process spawns, and no code path edits it: the frozen-write primitive
 * refuses a second write, and this module exposes no update function.
 */
export function writeRunRecord(runDir: string, facts: RunRecordFacts): RunRecord {
	const record: RunRecord = { formatVersion: RUN_STORE_FORMAT_VERSION, ...facts };
	writeFrozenFile(join(runDir, RUN_RECORD_NAME), `${JSON.stringify(record, null, "\t")}\n`);
	return record;
}

/** Read the run record, or null when it does not exist yet. */
export function readRunRecord(runDir: string): RunRecord | null {
	return readFrozenJson(join(runDir, RUN_RECORD_NAME)) as RunRecord | null;
}
