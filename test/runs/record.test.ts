import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FrozenFileExistsError, RUN_STORE_FORMAT_VERSION } from "../../src/runs/artifacts.ts";
import {
	RUN_RECORD_NAME,
	type RunLaunchShape,
	type RunRecordFacts,
	type RunSessionRef,
	readRunRecord,
	writeRunRecord,
} from "../../src/runs/record.ts";
import { after, assert, before, createTestDir, describe, it, rmSync } from "../support/index.ts";

function recordFacts(runId: string): RunRecordFacts {
	const session: RunSessionRef = {
		file: "/home/user/.pi/agent/sessions/--proj--/abc.jsonl",
		id: "abc",
	};
	const launch: RunLaunchShape = {
		agent: "scout",
		mode: "background",
		cwd: "/tmp/alpha/proj",
		timeoutSeconds: 600,
		idleTimeoutSeconds: null,
		timeoutWarnThreshold: 80,
		onTimeout: "report",
		contextWarnAt: [100_000, 150_000],
	};
	return {
		runId,
		createdAt: "2026-09-04T10:00:00.000Z",
		session,
		resumeOf: null,
		parent: {
			sessionId: "parent-session",
			process: { pid: 4242, startTime: "1000", command: "pi" },
		},
		launch,
		piVersion: "0.85.0",
	};
}

describe("run record", () => {
	let dir: string;
	let runCount = 0;

	before(() => {
		dir = createTestDir();
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function freshRunDir(): string {
		runCount += 1;
		const runDir = join(dir, `run-${runCount}`);
		mkdirSync(runDir);
		return runDir;
	}

	it("writes the pre-spawn facts with the format version and reads them back", () => {
		const runDir = freshRunDir();
		const facts = recordFacts("run-1");

		const written = writeRunRecord(runDir, facts);

		assert.equal(written.formatVersion, RUN_STORE_FORMAT_VERSION);
		assert.deepEqual(readRunRecord(runDir), { formatVersion: RUN_STORE_FORMAT_VERSION, ...facts });
	});

	it("holds only pre-spawn facts plus the format version", () => {
		const runDir = freshRunDir();
		writeRunRecord(runDir, recordFacts("run-2"));

		const stored = JSON.parse(readFileSync(join(runDir, RUN_RECORD_NAME), "utf8"));

		assert.deepEqual(Object.keys(stored).sort(), [
			"createdAt",
			"formatVersion",
			"launch",
			"parent",
			"piVersion",
			"resumeOf",
			"runId",
			"session",
		]);
	});

	it("refuses a second write: the record is frozen", () => {
		const runDir = freshRunDir();
		const facts = recordFacts("run-3");
		writeRunRecord(runDir, facts);

		assert.throws(
			() => writeRunRecord(runDir, { ...facts, piVersion: "9.9.9" }),
			FrozenFileExistsError,
		);

		assert.deepEqual(readRunRecord(runDir), { formatVersion: RUN_STORE_FORMAT_VERSION, ...facts });
	});

	it("records a no-session launch and resume lineage", () => {
		const runDir = freshRunDir();
		const facts: RunRecordFacts = {
			...recordFacts("run-4"),
			session: { noSession: true },
			resumeOf: "run-1",
		};

		writeRunRecord(runDir, facts);

		const stored = readRunRecord(runDir);
		assert.ok(stored);
		assert.deepEqual(stored.session, { noSession: true });
		assert.equal(stored.resumeOf, "run-1");
	});

	it("returns null when no record exists yet", () => {
		assert.equal(readRunRecord(freshRunDir()), null);
	});
});
