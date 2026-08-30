import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

let releases: Array<() => void> = [];
let testDir = "";
let importCount = 0;
let acquireLiveWindowLock: (scriptName: string) => () => void;
let requireLiveWindowOptIn: (scriptName: string) => void;

describe("live-test-guard", () => {
	// The hooks live inside the describe so they scope to this suite only:
	// the shared test entry point runs every suite in one process, and a
	// top-level hook there would wrap every test in the whole run.
	beforeEach(async () => {
		testDir = mkdtempSync(join(tmpdir(), "live-test-guard-"));
		process.env.PI_SUBAGENT_LIVE_LOCK_PATH = join(testDir, "window.lock");
		// A counter keeps every import URL unique. A time-based buster can
		// repeat within one millisecond and hand back a cached module that
		// still points at the previous, already deleted, lock directory.
		importCount += 1;
		({ acquireLiveWindowLock, requireLiveWindowOptIn } = await import(
			`../scripts/live-test-guard.mjs?instance=${importCount}`
		));
	});

	afterEach(() => {
		for (const release of releases.reverse()) {
			try {
				release();
			} catch {}
		}
		releases = [];
		delete process.env.PI_SUBAGENT_LIVE_LOCK_PATH;
		if (testDir) rmSync(testDir, { recursive: true, force: true });
		testDir = "";
	});

	it("refuses live window scripts unless explicitly opted in", () => {
		delete process.env.PI_SUBAGENT_ALLOW_LIVE_WINDOWS;
		assert.throws(
			() => requireLiveWindowOptIn("test-e2e-live"),
			/PI_SUBAGENT_ALLOW_LIVE_WINDOWS=1/,
		);

		process.env.PI_SUBAGENT_ALLOW_LIVE_WINDOWS = "1";
		assert.doesNotThrow(() => requireLiveWindowOptIn("test-e2e-live"));
		delete process.env.PI_SUBAGENT_ALLOW_LIVE_WINDOWS;
	});

	it("refuses a second live window lock while one is active", () => {
		const release = acquireLiveWindowLock("first-test");
		releases.push(release);

		assert.throws(
			() => acquireLiveWindowLock("second-test"),
			/Refusing to spawn another live terminal window/,
		);
	});

	it("allows reacquiring the lock after release", () => {
		const first = acquireLiveWindowLock("first-test");
		first();

		const second = acquireLiveWindowLock("second-test");
		releases.push(second);
		assert.equal(typeof second, "function");
	});
});
