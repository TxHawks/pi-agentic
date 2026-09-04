import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createExclusiveFile,
	ensureRunArtifactRoot,
	ensureRunProjectDir,
	FORMAT_MARKER_NAME,
	FrozenFileExistsError,
	OUTCOME_RECORD_NAME,
	OutcomeUpgradeError,
	RUN_STORE_FORMAT_VERSION,
	RunStoreFormatError,
	readFrozenJson,
	replaceLostOutcome,
	runProjectDirName,
	StateSwapLostError,
	swapStateName,
	TEMP_FILE_PREFIX,
	writeFrozenFile,
} from "../../src/runs/artifacts.ts";
import { after, assert, before, createTestDir, describe, it, rmSync } from "../support/index.ts";

describe("run artifact root", () => {
	let dir: string;
	let rootCount = 0;

	before(() => {
		dir = createTestDir();
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function freshRoot(): string {
		rootCount += 1;
		return join(dir, `root-${rootCount}`);
	}

	it("creates the root with mode 0700 and writes the format marker", () => {
		const root = freshRoot();

		ensureRunArtifactRoot(root);

		assert.equal(statSync(root).mode & 0o777, 0o700);
		const marker = JSON.parse(readFileSync(join(root, FORMAT_MARKER_NAME), "utf8"));
		assert.deepEqual(marker, { formatVersion: RUN_STORE_FORMAT_VERSION });
	});

	it("accepts an existing root with the current format marker", () => {
		const root = freshRoot();
		ensureRunArtifactRoot(root);

		ensureRunArtifactRoot(root);

		assert.equal(statSync(root).mode & 0o777, 0o700);
	});

	it("tightens the permissions of an existing root to 0700", () => {
		const root = freshRoot();
		mkdirSync(root, { recursive: true, mode: 0o755 });

		ensureRunArtifactRoot(root);

		assert.equal(statSync(root).mode & 0o777, 0o700);
	});

	it("refuses a root whose format marker names another version", () => {
		const root = freshRoot();
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, FORMAT_MARKER_NAME), JSON.stringify({ formatVersion: 999 }));

		assert.throws(
			() => ensureRunArtifactRoot(root),
			(error: unknown) => {
				assert.ok(error instanceof RunStoreFormatError);
				assert.match(error.message, /999/);
				assert.match(error.message, new RegExp(String(RUN_STORE_FORMAT_VERSION)));
				return true;
			},
		);
	});

	it("keys project directories by the sanitized full path of the project root", () => {
		assert.equal(runProjectDirName("/tmp/alpha/proj"), "--tmp-alpha-proj--");
		assert.notEqual(runProjectDirName("/tmp/alpha/proj"), runProjectDirName("/tmp/beta/proj"));
	});

	it("creates a project directory under the root, keyed by sanitized full path", () => {
		const root = freshRoot();
		ensureRunArtifactRoot(root);

		const projectDir = ensureRunProjectDir(root, "/tmp/alpha/proj");

		assert.equal(projectDir, join(root, "--tmp-alpha-proj--"));
		assert.ok(existsSync(projectDir));
		assert.equal(statSync(projectDir).mode & 0o777, 0o700);
	});
});

describe("run artifact write primitives", () => {
	let dir: string;
	let dirCount = 0;

	before(() => {
		dir = createTestDir();
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function freshDir(): string {
		dirCount += 1;
		const path = join(dir, `dir-${dirCount}`);
		mkdirSync(path);
		return path;
	}

	it("writes a frozen file with full content and leaves no temp file behind", () => {
		const base = freshDir();
		const path = join(base, "record.json");

		writeFrozenFile(path, '{"fact":"value"}\n');

		assert.equal(readFileSync(path, "utf8"), '{"fact":"value"}\n');
		assert.deepEqual(readdirSync(base), ["record.json"]);
	});

	it("refuses a second write to a frozen file and keeps the first content", () => {
		const base = freshDir();
		const path = join(base, "record.json");
		writeFrozenFile(path, "first");

		assert.throws(() => writeFrozenFile(path, "second"), FrozenFileExistsError);

		assert.equal(readFileSync(path, "utf8"), "first");
		assert.deepEqual(readdirSync(base), ["record.json"]);
	});

	it("never shows a partial file at the real name after a simulated crash", () => {
		// A crash between the temp write and the link leaves only a truncated
		// temp file. The real name must not exist, a read must return null, and
		// a later write must still work.
		const base = freshDir();
		const path = join(base, "record.json");
		writeFileSync(join(base, `${TEMP_FILE_PREFIX}leftover`), '{"truncated":');

		assert.equal(existsSync(path), false);
		assert.equal(readFrozenJson(path), null);

		writeFrozenFile(path, '{"whole":true}');
		assert.deepEqual(readFrozenJson(path), { whole: true });
	});

	it("creates an exclusive file with one winner", () => {
		const base = freshDir();
		const path = join(base, "delivered");

		assert.equal(createExclusiveFile(path, "winner"), true);
		assert.equal(createExclusiveFile(path, "loser"), false);

		assert.equal(readFileSync(path, "utf8"), "winner");
	});

	it("swaps a state-file name atomically and fails the loser loudly", () => {
		const base = freshDir();
		assert.equal(createExclusiveFile(join(base, "owner--released")), true);

		swapStateName(base, "owner--released", "owner--owned--session-a");

		assert.ok(existsSync(join(base, "owner--owned--session-a")));
		assert.equal(existsSync(join(base, "owner--released")), false);
		assert.throws(
			() => swapStateName(base, "owner--released", "owner--owned--session-b"),
			StateSwapLostError,
		);
		assert.equal(existsSync(join(base, "owner--owned--session-b")), false);
	});

	it("replaces an outcome record only to upgrade a lost outcome", () => {
		const base = freshDir();
		writeFrozenFile(join(base, OUTCOME_RECORD_NAME), '{"class":"lost"}');

		replaceLostOutcome(base, '{"class":"success"}');

		assert.deepEqual(readFrozenJson(join(base, OUTCOME_RECORD_NAME)), { class: "success" });
		assert.deepEqual(readdirSync(base), [OUTCOME_RECORD_NAME]);
	});

	it("refuses to replace a settled outcome that is not lost", () => {
		const base = freshDir();
		writeFrozenFile(join(base, OUTCOME_RECORD_NAME), '{"class":"stopped"}');

		assert.throws(() => replaceLostOutcome(base, '{"class":"success"}'), OutcomeUpgradeError);

		assert.deepEqual(readFrozenJson(join(base, OUTCOME_RECORD_NAME)), { class: "stopped" });
	});

	it("refuses to replace an outcome record that does not exist", () => {
		const base = freshDir();

		assert.throws(() => replaceLostOutcome(base, '{"class":"success"}'), OutcomeUpgradeError);

		assert.equal(existsSync(join(base, OUTCOME_RECORD_NAME)), false);
	});
});
