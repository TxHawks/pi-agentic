import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUTCOME_RECORD_NAME, writeFrozenFile } from "../../src/runs/artifacts.ts";
import {
	countProjectPoolRuns,
	countSessionLiveRuns,
	QUEUED_MARKER_NAME,
	runDirPath,
	runsDirPath,
	SPAWNED_MARKER_NAME,
} from "../../src/runs/live-state.ts";
import { type RunRecordFacts, writeRunRecord } from "../../src/runs/record.ts";
import { EXIT_RECORD_NAME } from "../../src/runs/wrapper.ts";
import { after, assert, before, createTestDir, describe, it, rmSync } from "../support/index.ts";

interface RunShape {
	owner?: string;
	marker?: "queued" | "spawned" | null;
	exited?: boolean;
	outcomeClass?: string;
}

function runFacts(runId: string, owner: string): RunRecordFacts {
	return {
		runId,
		createdAt: "2026-09-05T08:00:00.000Z",
		session: { file: `/sessions/${runId}.jsonl`, id: `child-${runId}` },
		resumeOf: null,
		parent: {
			sessionId: owner,
			process: { pid: 100, startTime: "1000", command: "pi" },
		},
		launch: {
			agent: "scout",
			mode: "background",
			cwd: "/tmp/proj",
			timeoutSeconds: null,
			idleTimeoutSeconds: null,
			timeoutWarnThreshold: null,
			onTimeout: null,
			contextWarnAt: [],
		},
		piVersion: "0.85.0",
	};
}

describe("run live state", () => {
	let dir: string;
	let projectDir: string;
	let runCount = 0;

	before(() => {
		dir = createTestDir();
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function freshProjectDir(): string {
		runCount += 1;
		projectDir = join(dir, `project-${runCount}`);
		mkdirSync(runsDirPath(projectDir), { recursive: true });
		return projectDir;
	}

	function makeRun(runId: string, shape: RunShape): string {
		const runDir = runDirPath(projectDir, runId);
		mkdirSync(runDir);
		writeRunRecord(runDir, runFacts(runId, shape.owner ?? "owner-1"));
		if (shape.marker === "queued") {
			writeFileSync(join(runDir, QUEUED_MARKER_NAME), "");
		}
		if (shape.marker === "spawned") {
			writeFileSync(join(runDir, SPAWNED_MARKER_NAME), "");
		}
		if (shape.exited) {
			writeFrozenFile(join(runDir, EXIT_RECORD_NAME), '{"waitStatus":0,"endedAt":"x"}\n');
		}
		if (shape.outcomeClass) {
			writeFrozenFile(
				join(runDir, OUTCOME_RECORD_NAME),
				`${JSON.stringify({ class: shape.outcomeClass })}\n`,
			);
		}
		return runDir;
	}

	it("counts a queued run for its owner but not for the project pool", () => {
		freshProjectDir();
		makeRun("r1", { marker: "queued" });

		assert.equal(countSessionLiveRuns(projectDir, "owner-1"), 1);
		assert.equal(countProjectPoolRuns(projectDir), 0);
	});

	it("counts a spawned run for both its owner and the project pool", () => {
		freshProjectDir();
		makeRun("r1", { marker: "spawned" });

		assert.equal(countSessionLiveRuns(projectDir, "owner-1"), 1);
		assert.equal(countProjectPoolRuns(projectDir), 1);
	});

	it("counts an exited run for its owner until an outcome exists, not for the pool", () => {
		freshProjectDir();
		makeRun("r1", { marker: "spawned", exited: true });

		assert.equal(countSessionLiveRuns(projectDir, "owner-1"), 1);
		assert.equal(countProjectPoolRuns(projectDir), 0);
	});

	it("counts a settled run for nobody", () => {
		freshProjectDir();
		makeRun("r1", { marker: "spawned", exited: true, outcomeClass: "completed" });

		assert.equal(countSessionLiveRuns(projectDir, "owner-1"), 0);
		assert.equal(countProjectPoolRuns(projectDir), 0);
	});

	it("counts a lost run for both its owner and the project pool", () => {
		freshProjectDir();
		makeRun("r1", { marker: "spawned", outcomeClass: "lost" });

		assert.equal(countSessionLiveRuns(projectDir, "owner-1"), 1);
		assert.equal(countProjectPoolRuns(projectDir), 1);
	});

	it("counts a run with a record but no launch marker for its owner only", () => {
		freshProjectDir();
		makeRun("r1", { marker: null });

		assert.equal(countSessionLiveRuns(projectDir, "owner-1"), 1);
		assert.equal(countProjectPoolRuns(projectDir), 0);
	});

	it("counts only the runs of the asked owner", () => {
		freshProjectDir();
		makeRun("r1", { marker: "spawned", owner: "owner-1" });
		makeRun("r2", { marker: "spawned", owner: "owner-2" });
		makeRun("r3", { marker: "queued", owner: "owner-2" });

		assert.equal(countSessionLiveRuns(projectDir, "owner-1"), 1);
		assert.equal(countSessionLiveRuns(projectDir, "owner-2"), 2);
		assert.equal(countProjectPoolRuns(projectDir), 2);
	});

	it("ignores a run directory without a record and stray files", () => {
		freshProjectDir();
		mkdirSync(runDirPath(projectDir, "no-record"));
		writeFileSync(join(runsDirPath(projectDir), "stray.txt"), "not a run");
		makeRun("r1", { marker: "spawned" });

		assert.equal(countSessionLiveRuns(projectDir, "owner-1"), 1);
		assert.equal(countProjectPoolRuns(projectDir), 1);
	});

	it("answers zero when the project has no runs directory", () => {
		const empty = join(dir, "empty-project");
		mkdirSync(empty);

		assert.equal(countSessionLiveRuns(empty, "owner-1"), 0);
		assert.equal(countProjectPoolRuns(empty), 0);
	});
});
