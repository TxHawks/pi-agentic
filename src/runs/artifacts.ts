/**
 * The write rules of the run store, in one place. No run artifact is ever
 * edited in place, so a reader can never see a torn state. Three classes:
 *
 * 1. Write-once frozen files (run record, child identity, exit record,
 *    intent records, the delivered marker, prompt and task files):
 *    writeFrozenFile, or createExclusiveFile for a small marker.
 * 2. Name-is-the-state files (owner marker, writer guard): created with
 *    createExclusiveFile, changed only through swapStateName.
 * 3. Two defined exceptions: the observation log is append-only and the
 *    child process owns its descriptor, so no primitive here writes it;
 *    the outcome record may be replaced only to upgrade a revisable lost
 *    (replaceLostOutcome).
 */
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The format of the run artifact root and of every record in it. */
export const RUN_STORE_FORMAT_VERSION = 1;

/** The marker file at the artifact root that names the store format. */
export const FORMAT_MARKER_NAME = "format.json";

/** Prefix of the temp files that the frozen-write primitive uses. */
export const TEMP_FILE_PREFIX = ".tmp-";

/** The outcome record of one run, inside its run directory. */
export const OUTCOME_RECORD_NAME = "outcome.json";

/** The artifact root holds a format this code does not know. */
export class RunStoreFormatError extends Error {
	constructor(root: string, found: unknown) {
		super(
			`The run artifact root ${root} has format ${JSON.stringify(found)}, ` +
				`but this code knows format ${RUN_STORE_FORMAT_VERSION}. ` +
				"Refusing to touch it.",
		);
		this.name = "RunStoreFormatError";
	}
}

/** A second write hit a frozen file. Frozen files are written once, then never change. */
export class FrozenFileExistsError extends Error {
	constructor(path: string) {
		super(`Refused to write the frozen file ${path}: it already exists.`);
		this.name = "FrozenFileExistsError";
	}
}

/** A name swap lost its race: the source name was already gone. */
export class StateSwapLostError extends Error {
	constructor(dir: string, fromName: string, toName: string) {
		super(
			`Lost the state swap ${fromName} -> ${toName} in ${dir}: ` +
				"the source name is gone, so another actor changed the state first.",
		);
		this.name = "StateSwapLostError";
	}
}

/** A replace hit an outcome record that is not an upgradable lost. */
export class OutcomeUpgradeError extends Error {
	constructor(runDir: string, reason: string) {
		super(`Refused to replace the outcome record in ${runDir}: ${reason}`);
		this.name = "OutcomeUpgradeError";
	}
}

/**
 * Write-once frozen file. The full content is written to a temp file in the
 * same directory, synced, then linked to the final name. A reader sees the
 * final name with full content or not at all. link() fails atomically when
 * the name exists, so no code path can replace a frozen file through this
 * primitive.
 */
export function writeFrozenFile(path: string, content: string): void {
	const temp = writeTempFile(dirname(path), content);
	try {
		linkSync(temp, path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new FrozenFileExistsError(path);
		}
		throw error;
	} finally {
		unlinkSync(temp);
	}
}

/**
 * Make sure the run artifact root exists with mode 0700 and the current
 * format marker. Refuses a root whose marker names another format, so a
 * future format change migrates or refuses instead of corrupting.
 */
export function ensureRunArtifactRoot(root: string): void {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	chmodSync(root, 0o700);
	const markerPath = join(root, FORMAT_MARKER_NAME);
	try {
		writeFrozenFile(markerPath, `${JSON.stringify({ formatVersion: RUN_STORE_FORMAT_VERSION })}\n`);
	} catch (error) {
		if (!(error instanceof FrozenFileExistsError)) throw error;
	}
	const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { formatVersion?: unknown };
	if (marker.formatVersion !== RUN_STORE_FORMAT_VERSION) {
		throw new RunStoreFormatError(root, marker.formatVersion);
	}
}

/**
 * The directory name of one project inside the artifact root: the sanitized
 * full path of the project root, in Pi's session-directory convention. Two
 * projects with one directory name never share storage.
 */
export function runProjectDirName(projectRoot: string): string {
	const resolved = resolve(projectRoot);
	return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Make sure the project directory exists under the artifact root. */
export function ensureRunProjectDir(root: string, projectRoot: string): string {
	const projectDir = join(root, runProjectDirName(projectRoot));
	mkdirSync(projectDir, { recursive: true, mode: 0o700 });
	chmodSync(projectDir, 0o700);
	return projectDir;
}

/**
 * Create a file that only one actor may create. Reports won (created) or
 * lost (the name already exists). The content is frozen at creation.
 */
export function createExclusiveFile(path: string, content = ""): boolean {
	try {
		writeFileSync(path, content, { flag: "wx", mode: 0o600 });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

/**
 * Change the state that a file name encodes, by one atomic rename. The
 * source name is the compare, the target name is the swap: when the source
 * is already gone, another actor changed the state first, and this caller
 * gets a loud error instead of a silent last-writer-wins.
 */
export function swapStateName(dir: string, fromName: string, toName: string): void {
	try {
		renameSync(join(dir, fromName), join(dir, toName));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new StateSwapLostError(dir, fromName, toName);
		}
		throw error;
	}
}

/**
 * Replace the outcome record of one run. This is the one defined exception
 * to the no-edit rule, and it only upgrades a revisable lost outcome. Every
 * other outcome class is final and stays as written.
 */
export function replaceLostOutcome(runDir: string, content: string): void {
	const path = join(runDir, OUTCOME_RECORD_NAME);
	const current = readFrozenJson(path) as { class?: unknown } | null;
	if (current === null) {
		throw new OutcomeUpgradeError(runDir, "there is no outcome record to upgrade.");
	}
	if (current.class !== "lost") {
		throw new OutcomeUpgradeError(
			runDir,
			`its class is ${JSON.stringify(current.class)}, and only a lost outcome may be replaced.`,
		);
	}
	renameSync(writeTempFile(runDir, content), path);
}

/**
 * Write the full content to a fresh temp file in the given directory and
 * sync it. The write loop covers a short write, so the temp file can never
 * carry partial content when this returns.
 */
function writeTempFile(dir: string, content: string): string {
	const temp = join(dir, `${TEMP_FILE_PREFIX}${randomBytes(8).toString("hex")}`);
	const data = Buffer.from(content, "utf8");
	const fd = openSync(temp, "wx", 0o600);
	try {
		let written = 0;
		while (written < data.length) {
			written += writeSync(fd, data, written);
		}
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	return temp;
}

/**
 * Read one frozen JSON file. Missing means null. A frozen file is written
 * atomically, so a torn read cannot occur; malformed content is a real
 * anomaly and throws.
 */
export function readFrozenJson(path: string): unknown {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	return JSON.parse(text);
}
