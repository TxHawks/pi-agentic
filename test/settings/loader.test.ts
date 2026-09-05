import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	defaultSettings,
	loadSettings,
	SETTINGS_FILE_NAME,
	type Settings,
	SettingsError,
} from "../../src/settings/loader.ts";
import { afterEach, assert, createTestDir, describe, it } from "../support/index.ts";

interface SettingsRoots {
	cwd: string;
	agentDir: string;
}

const openDirs: string[] = [];

function makeRoots(): SettingsRoots {
	const cwd = createTestDir();
	const agentDir = createTestDir();
	openDirs.push(cwd, agentDir);
	return { cwd, agentDir };
}

function removeRoots(): void {
	for (const dir of openDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
}

function globalFilePath(roots: SettingsRoots): string {
	return join(roots.agentDir, SETTINGS_FILE_NAME);
}

function projectFilePath(roots: SettingsRoots): string {
	return join(roots.cwd, ".pi", SETTINGS_FILE_NAME);
}

function writeGlobalFile(roots: SettingsRoots, content: string): void {
	writeFileSync(globalFilePath(roots), content);
}

function writeProjectFile(roots: SettingsRoots, content: string): void {
	mkdirSync(join(roots.cwd, ".pi"), { recursive: true });
	writeFileSync(projectFilePath(roots), content);
}

function load(roots: SettingsRoots, projectTrusted = true): Settings {
	return loadSettings({ ...roots, projectTrusted });
}

function assertSettingsError(fn: () => unknown, messagePart: string): void {
	assert.throws(fn, (error: unknown) => {
		assert.ok(error instanceof SettingsError, "the error must be a SettingsError");
		assert.ok(
			error.message.includes(messagePart),
			`expected the message to include ${JSON.stringify(messagePart)}, got: ${error.message}`,
		);
		return true;
	});
}

const specDefaults: Settings = {
	piCommand: null,
	mux: null,
	coordinatorOnlyTurn: true,
	childContextBoundary: true,
	sessionTitles: true,
	setTabTitle: false,
	shellReadyDelayMs: 500,
	traceLog: null,
	providerRecoveryDelaysMs: [30_000, 60_000, 90_000],
	artifactRoot: join(homedir(), ".pi", "history"),
	overlayKey: "alt+s",
	spawnDepth: null,
	spawnWidth: null,
	runPoolSize: 16,
	queueWaitLimitMs: 3_600_000,
	retention: {
		maxAgeMs: 14 * 24 * 3_600_000,
		maxLogSizeBytes: 500 * 1024 * 1024,
	},
	herdr: { placement: "auto", minColumns: 50, minRows: 12 },
	zellij: { placement: "auto", minColumns: 50, minRows: 10 },
	tmux: { renameWindow: false, renameSession: false },
};

describe("settings defaults", () => {
	afterEach(removeRoots);

	it("returns the spec defaults when no settings file exists", () => {
		assert.deepEqual(load(makeRoots()), specDefaults);
	});

	it("exposes the spec defaults through defaultSettings()", () => {
		assert.deepEqual(defaultSettings(), specDefaults);
	});

	it("returns a fresh object on every load", () => {
		const roots = makeRoots();
		const first = load(roots);
		const second = load(roots);
		assert.notEqual(first, second);
		assert.notEqual(first.retention, second.retention);
	});
});

describe("settings file reading", () => {
	afterEach(removeRoots);

	it("applies keys from the global file and keeps defaults for unset keys", () => {
		const roots = makeRoots();
		writeGlobalFile(roots, `{ "mux": "tmux", "shell-ready-delay-ms": 250 }`);
		const settings = load(roots);
		assert.equal(settings.mux, "tmux");
		assert.equal(settings.shellReadyDelayMs, 250);
		assert.equal(settings.runPoolSize, 16);
		assert.equal(settings.overlayKey, "alt+s");
	});

	it("reads every spec key from one file", () => {
		const roots = makeRoots();
		writeGlobalFile(
			roots,
			`{
				"pi-command": "node /opt/pi/main.js",
				"mux": "zellij",
				"coordinator-only-turn": false,
				"child-context-boundary": false,
				"session-titles": false,
				"set-tab-title": true,
				"shell-ready-delay-ms": 0,
				"trace-log": "/tmp/subagents-trace.log",
				"provider-recovery-delays-ms": [10000, 20000],
				"artifact-root": "/tmp/subagent-artifacts",
				"overlay-key": "none",
				"spawn-depth": 2,
				"spawn-width": 4,
				"run-pool-size": 8,
				"queue-wait-limit": "30m",
				"retention": { "max-age": "7d", "max-log-size": "100mb" },
				"herdr": { "placement": "tab", "min-columns": 60, "min-rows": 20 },
				"zellij": { "placement": "floating", "min-columns": 70, "min-rows": 15 },
				"tmux": { "rename-window": true, "rename-session": true }
			}`,
		);
		assert.deepEqual(load(roots), {
			piCommand: "node /opt/pi/main.js",
			mux: "zellij",
			coordinatorOnlyTurn: false,
			childContextBoundary: false,
			sessionTitles: false,
			setTabTitle: true,
			shellReadyDelayMs: 0,
			traceLog: "/tmp/subagents-trace.log",
			providerRecoveryDelaysMs: [10_000, 20_000],
			artifactRoot: "/tmp/subagent-artifacts",
			overlayKey: "none",
			spawnDepth: 2,
			spawnWidth: 4,
			runPoolSize: 8,
			queueWaitLimitMs: 1_800_000,
			retention: {
				maxAgeMs: 7 * 24 * 3_600_000,
				maxLogSizeBytes: 100 * 1024 * 1024,
			},
			herdr: { placement: "tab", minColumns: 60, minRows: 20 },
			zellij: { placement: "floating", minColumns: 70, minRows: 15 },
			tmux: { renameWindow: true, renameSession: true },
		} satisfies Settings);
	});

	it("accepts comments and trailing commas", () => {
		const roots = makeRoots();
		writeGlobalFile(
			roots,
			`{
				// line comment
				"mux": "herdr", // trailing comment
				/* block
				   comment */
				"provider-recovery-delays-ms": [15000, 25000,],
				"run-pool-size": 4,
			}`,
		);
		const settings = load(roots);
		assert.equal(settings.mux, "herdr");
		assert.deepEqual(settings.providerRecoveryDelaysMs, [15_000, 25_000]);
		assert.equal(settings.runPoolSize, 4);
	});

	it("keeps comment-like text inside string values", () => {
		const roots = makeRoots();
		writeGlobalFile(roots, `{ "trace-log": "/tmp/dir//trace.log" }`);
		assert.equal(load(roots).traceLog, "/tmp/dir//trace.log");
	});

	it("expands a leading ~ in path values", () => {
		const roots = makeRoots();
		writeGlobalFile(roots, `{ "artifact-root": "~/custom-runs", "trace-log": "~/logs/trace.log" }`);
		const settings = load(roots);
		assert.equal(settings.artifactRoot, join(homedir(), "custom-runs"));
		assert.equal(settings.traceLog, join(homedir(), "logs/trace.log"));
	});
});

describe("settings precedence and trust", () => {
	afterEach(removeRoots);

	it("lets a project key override the same global key", () => {
		const roots = makeRoots();
		writeGlobalFile(roots, `{ "mux": "tmux", "run-pool-size": 4 }`);
		writeProjectFile(roots, `{ "mux": "zellij" }`);
		const settings = load(roots);
		assert.equal(settings.mux, "zellij");
		assert.equal(settings.runPoolSize, 4);
	});

	it("merges nested blocks key by key", () => {
		const roots = makeRoots();
		writeGlobalFile(roots, `{ "herdr": { "min-columns": 80 }, "retention": { "max-age": "7d" } }`);
		writeProjectFile(
			roots,
			`{ "herdr": { "placement": "tab" }, "retention": { "max-log-size": "100mb" } }`,
		);
		const settings = load(roots);
		assert.deepEqual(settings.herdr, { placement: "tab", minColumns: 80, minRows: 12 });
		assert.deepEqual(settings.retention, {
			maxAgeMs: 7 * 24 * 3_600_000,
			maxLogSizeBytes: 100 * 1024 * 1024,
		});
	});

	it("lets a project file set a nullable key back to its default with null", () => {
		const roots = makeRoots();
		writeGlobalFile(
			roots,
			`{ "mux": "tmux", "spawn-depth": 3, "trace-log": "/tmp/t.log", "pi-command": "pi" }`,
		);
		writeProjectFile(
			roots,
			`{ "mux": null, "spawn-depth": null, "trace-log": null, "pi-command": null }`,
		);
		const settings = load(roots);
		assert.equal(settings.mux, null);
		assert.equal(settings.spawnDepth, null);
		assert.equal(settings.traceLog, null);
		assert.equal(settings.piCommand, null);
	});

	it("does not read the project file when the project is not trusted", () => {
		const roots = makeRoots();
		writeGlobalFile(roots, `{ "mux": "tmux" }`);
		writeProjectFile(roots, `{ "mux": "zellij" }`);
		assert.equal(load(roots, false).mux, "tmux");
	});

	it("never parses an untrusted project file, even a broken one", () => {
		const roots = makeRoots();
		writeProjectFile(roots, "{ this is not JSONC");
		assert.deepEqual(load(roots, false), specDefaults);
	});
});

describe("settings error reporting", () => {
	afterEach(removeRoots);

	it("throws a loud error that names the file for broken global JSONC", () => {
		const roots = makeRoots();
		writeGlobalFile(roots, "{ broken");
		assertSettingsError(() => load(roots), globalFilePath(roots));
	});

	it("throws a loud error that names the file for broken project JSONC", () => {
		const roots = makeRoots();
		writeProjectFile(roots, `{ "mux": }`);
		assertSettingsError(() => load(roots), projectFilePath(roots));
	});

	it("throws when the file is not one JSONC object", () => {
		const roots = makeRoots();
		writeGlobalFile(roots, `[1, 2, 3]`);
		assertSettingsError(() => load(roots), "one JSONC object");
	});

	it("throws for an unknown top-level key", () => {
		const roots = makeRoots();
		writeGlobalFile(roots, `{ "overlaykey": "alt+s" }`);
		assertSettingsError(() => load(roots), '"overlaykey"');
	});

	it("throws for an unknown key inside a block", () => {
		const roots = makeRoots();
		writeGlobalFile(roots, `{ "retention": { "max-days": "14d" } }`);
		assertSettingsError(() => load(roots), '"retention.max-days"');
	});
});

describe("settings value rules", () => {
	afterEach(removeRoots);

	function assertRejects(content: string, messagePart: string): void {
		const roots = makeRoots();
		writeGlobalFile(roots, content);
		assertSettingsError(() => load(roots), messagePart);
	}

	it("rejects a boolean key that is not a boolean", () => {
		assertRejects(`{ "session-titles": "yes" }`, '"session-titles"');
	});

	it("rejects an unknown mux backend", () => {
		assertRejects(`{ "mux": "screen" }`, '"mux"');
	});

	it("rejects an empty pi-command", () => {
		assertRejects(`{ "pi-command": "  " }`, '"pi-command"');
	});

	it("rejects a negative or fractional delay", () => {
		assertRejects(`{ "shell-ready-delay-ms": -1 }`, '"shell-ready-delay-ms"');
		assertRejects(`{ "shell-ready-delay-ms": 1.5 }`, '"shell-ready-delay-ms"');
	});

	it("rejects a run pool size below one", () => {
		assertRejects(`{ "run-pool-size": 0 }`, '"run-pool-size"');
	});

	it("rejects null for a key whose default is not null", () => {
		assertRejects(`{ "run-pool-size": null }`, '"run-pool-size"');
		assertRejects(`{ "session-titles": null }`, '"session-titles"');
	});

	it("accepts a spawn ceiling of zero and rejects negative ceilings", () => {
		const roots = makeRoots();
		writeGlobalFile(roots, `{ "spawn-depth": 0, "spawn-width": 0 }`);
		const settings = load(roots);
		assert.equal(settings.spawnDepth, 0);
		assert.equal(settings.spawnWidth, 0);
		assertRejects(`{ "spawn-depth": -1 }`, '"spawn-depth"');
	});

	it("rejects recovery delays that are not a list of whole milliseconds", () => {
		assertRejects(`{ "provider-recovery-delays-ms": 30000 }`, '"provider-recovery-delays-ms"');
		assertRejects(`{ "provider-recovery-delays-ms": ["30s"] }`, '"provider-recovery-delays-ms"');
		assertRejects(`{ "provider-recovery-delays-ms": [] }`, '"provider-recovery-delays-ms"');
	});

	it("rejects a placement that the backend does not have", () => {
		assertRejects(`{ "herdr": { "placement": "floating" } }`, '"herdr.placement"');
		assertRejects(`{ "zellij": { "placement": "right" } }`, '"zellij.placement"');
	});

	it("parses durations with a unit suffix", () => {
		const roots = makeRoots();
		writeGlobalFile(roots, `{ "queue-wait-limit": "90s", "retention": { "max-age": "36h" } }`);
		const settings = load(roots);
		assert.equal(settings.queueWaitLimitMs, 90_000);
		assert.equal(settings.retention.maxAgeMs, 36 * 3_600_000);
	});

	it("rejects a duration without a unit", () => {
		assertRejects(`{ "queue-wait-limit": 60 }`, '"queue-wait-limit"');
		assertRejects(`{ "retention": { "max-age": "14 days" } }`, '"retention.max-age"');
	});

	it("parses sizes with a unit suffix", () => {
		const roots = makeRoots();
		writeGlobalFile(roots, `{ "retention": { "max-log-size": "1gib" } }`);
		assert.equal(load(roots).retention.maxLogSizeBytes, 1024 * 1024 * 1024);
	});

	it("rejects a size without a unit", () => {
		assertRejects(`{ "retention": { "max-log-size": 500 } }`, '"retention.max-log-size"');
	});
});
