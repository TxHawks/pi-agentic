import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SettingsError } from "./error.ts";
import { parseJsonc } from "./jsonc.ts";

export { SettingsError } from "./error.ts";

/** The settings file name, in the Pi agent directory and in a project's `.pi/` directory. */
export const SETTINGS_FILE_NAME = "pi-agentic.jsonc";

const MUX_BACKENDS = ["cmux", "tmux", "zellij", "wezterm", "herdr"] as const;
const HERDR_PLACEMENTS = ["auto", "right-stack", "down-stack", "right", "down", "tab"] as const;
const ZELLIJ_PLACEMENTS = ["auto", "right-stack", "down-stack", "floating", "tab-stack"] as const;

type MuxBackendName = (typeof MUX_BACKENDS)[number];
type HerdrPlacement = (typeof HERDR_PLACEMENTS)[number];
type ZellijPlacement = (typeof ZELLIJ_PLACEMENTS)[number];

/**
 * All user configuration, as one typed object. Every field holds the value
 * from the settings files, or the default when no file sets the key. File
 * keys are kebab-case; durations and sizes arrive normalized (milliseconds
 * and bytes).
 */
export interface Settings {
	/** Command line that starts the Pi child. Null: start the same Pi that runs now. */
	piCommand: string | null;
	/** Pane backend for interactive children. Null: detect one at launch. */
	mux: MuxBackendName | null;
	/** End the parent turn after a subagent batch, so the parent stays a coordinator. */
	coordinatorOnlyTurn: boolean;
	/** Insert the boundary message that separates inherited context from the child task. */
	childContextBoundary: boolean;
	/** Give child sessions a readable title. */
	sessionTitles: boolean;
	/** Register the set_tab_title tool in child sessions. */
	setTabTitle: boolean;
	/** Wait this long for a pane shell before sending it the child command. */
	shellReadyDelayMs: number;
	/** File that receives launch trace lines. Null: no trace. */
	traceLog: string | null;
	/** Wait windows between provider-error recovery attempts. */
	providerRecoveryDelaysMs: number[];
	/** Directory that holds all durable artifacts of this extension. */
	artifactRoot: string;
	/** Shortcut that opens the run overlay. "none" turns the shortcut off. */
	overlayKey: string;
	/** Ceiling on nested launch depth. Null: no ceiling; the agent file still applies. */
	spawnDepth: number | null;
	/** Ceiling on live runs one session may own. Null: no ceiling; the agent file still applies. */
	spawnWidth: number | null;
	/** Most live runs one project may hold at the same time. */
	runPoolSize: number;
	/** How long an ownerless queued run may wait before any process may cancel it. */
	queueWaitLimitMs: number;
	retention: {
		/** Run artifacts are removed this long after the run settles. */
		maxAgeMs: number;
		/** A run whose observation log passes this size is stopped. */
		maxLogSizeBytes: number;
	};
	/** Pane placement for the herdr backend. */
	herdr: { placement: HerdrPlacement; minColumns: number; minRows: number };
	/** Pane placement for the zellij backend. */
	zellij: { placement: ZellijPlacement; minColumns: number; minRows: number };
	/** Whether the extension may rename tmux windows and sessions. */
	tmux: { renameWindow: boolean; renameSession: boolean };
}

export interface LoadSettingsOptions {
	/** The project root. The project file is `<cwd>/.pi/pi-agentic.jsonc`. */
	cwd: string;
	/** The Pi agent directory. The global file is `<agentDir>/pi-agentic.jsonc`. */
	agentDir: string;
	/** The project file is read only when this is true. */
	projectTrusted: boolean;
}

/** The spec defaults, as a fresh object. */
export function defaultSettings(): Settings {
	return {
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
}

/**
 * Load the settings: defaults, then the global file, then the project file.
 * A project key overrides the same global key; unset keys fall through.
 * A key whose default is null returns to that default when a file sets it
 * to null. A missing file is normal. A file that exists but is broken —
 * bad JSONC, an unknown key, or a bad value — throws a SettingsError that
 * names the file. No key comes from an environment variable.
 */
export function loadSettings(options: LoadSettingsOptions): Settings {
	const settings = defaultSettings();
	applySettingsFile(settings, join(options.agentDir, SETTINGS_FILE_NAME));
	if (options.projectTrusted) {
		applySettingsFile(settings, join(options.cwd, ".pi", SETTINGS_FILE_NAME));
	}
	return settings;
}

function applySettingsFile(settings: Settings, file: string): void {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return;
		throw new SettingsError(file, `the file cannot be read (${(error as Error).message})`);
	}
	const parsed = parseJsonc(text, file);
	if (!isPlainObject(parsed)) {
		throw new SettingsError(file, "the file must hold one JSONC object with settings keys");
	}
	for (const [key, value] of Object.entries(parsed)) {
		const apply = KEY_APPLIERS.get(key);
		if (!apply) {
			throw new SettingsError(
				file,
				`unknown key ${JSON.stringify(key)}. Known keys: ${[...KEY_APPLIERS.keys()].join(", ")}`,
			);
		}
		apply(settings, value, file);
	}
}

type ApplyKey = (settings: Settings, value: unknown, file: string) => void;

const KEY_APPLIERS: ReadonlyMap<string, ApplyKey> = new Map<string, ApplyKey>([
	[
		"pi-command",
		(settings, value, file) => {
			settings.piCommand = value === null ? null : readText(value, file, "pi-command");
		},
	],
	[
		"mux",
		(settings, value, file) => {
			settings.mux = value === null ? null : readChoice(value, file, "mux", MUX_BACKENDS);
		},
	],
	[
		"coordinator-only-turn",
		(settings, value, file) => {
			settings.coordinatorOnlyTurn = readBoolean(value, file, "coordinator-only-turn");
		},
	],
	[
		"child-context-boundary",
		(settings, value, file) => {
			settings.childContextBoundary = readBoolean(value, file, "child-context-boundary");
		},
	],
	[
		"session-titles",
		(settings, value, file) => {
			settings.sessionTitles = readBoolean(value, file, "session-titles");
		},
	],
	[
		"set-tab-title",
		(settings, value, file) => {
			settings.setTabTitle = readBoolean(value, file, "set-tab-title");
		},
	],
	[
		"shell-ready-delay-ms",
		(settings, value, file) => {
			settings.shellReadyDelayMs = readWholeNumber(value, file, "shell-ready-delay-ms", 0);
		},
	],
	[
		"trace-log",
		(settings, value, file) => {
			settings.traceLog = value === null ? null : readPath(value, file, "trace-log");
		},
	],
	[
		"provider-recovery-delays-ms",
		(settings, value, file) => {
			settings.providerRecoveryDelaysMs = readDelayList(value, file);
		},
	],
	[
		"artifact-root",
		(settings, value, file) => {
			settings.artifactRoot = readPath(value, file, "artifact-root");
		},
	],
	[
		"overlay-key",
		(settings, value, file) => {
			settings.overlayKey = readText(value, file, "overlay-key");
		},
	],
	[
		"spawn-depth",
		(settings, value, file) => {
			settings.spawnDepth = value === null ? null : readWholeNumber(value, file, "spawn-depth", 0);
		},
	],
	[
		"spawn-width",
		(settings, value, file) => {
			settings.spawnWidth = value === null ? null : readWholeNumber(value, file, "spawn-width", 0);
		},
	],
	[
		"run-pool-size",
		(settings, value, file) => {
			settings.runPoolSize = readWholeNumber(value, file, "run-pool-size", 1);
		},
	],
	[
		"queue-wait-limit",
		(settings, value, file) => {
			settings.queueWaitLimitMs = readDurationMs(value, file, "queue-wait-limit");
		},
	],
	["retention", applyRetentionBlock],
	[
		"herdr",
		(settings, value, file) => {
			applyPaneBlock("herdr", settings.herdr, HERDR_PLACEMENTS, value, file);
		},
	],
	[
		"zellij",
		(settings, value, file) => {
			applyPaneBlock("zellij", settings.zellij, ZELLIJ_PLACEMENTS, value, file);
		},
	],
	["tmux", applyTmuxBlock],
]);

function applyRetentionBlock(settings: Settings, value: unknown, file: string): void {
	forEachBlockKey(value, file, "retention", ["max-age", "max-log-size"], (key, subValue) => {
		if (key === "retention.max-age") {
			settings.retention.maxAgeMs = readDurationMs(subValue, file, key);
		} else {
			settings.retention.maxLogSizeBytes = readSizeBytes(subValue, file, key);
		}
	});
}

function applyPaneBlock<T extends string>(
	block: "herdr" | "zellij",
	pane: { placement: T; minColumns: number; minRows: number },
	placements: readonly T[],
	value: unknown,
	file: string,
): void {
	forEachBlockKey(value, file, block, ["placement", "min-columns", "min-rows"], (key, subValue) => {
		if (key === `${block}.placement`) {
			pane.placement = readChoice(subValue, file, key, placements);
		} else if (key === `${block}.min-columns`) {
			pane.minColumns = readWholeNumber(subValue, file, key, 1);
		} else {
			pane.minRows = readWholeNumber(subValue, file, key, 1);
		}
	});
}

function applyTmuxBlock(settings: Settings, value: unknown, file: string): void {
	forEachBlockKey(value, file, "tmux", ["rename-window", "rename-session"], (key, subValue) => {
		if (key === "tmux.rename-window") {
			settings.tmux.renameWindow = readBoolean(subValue, file, key);
		} else {
			settings.tmux.renameSession = readBoolean(subValue, file, key);
		}
	});
}

function forEachBlockKey(
	value: unknown,
	file: string,
	block: string,
	knownKeys: readonly string[],
	apply: (fullKey: string, subValue: unknown) => void,
): void {
	if (!isPlainObject(value)) {
		throw new SettingsError(file, `"${block}" must be an object with keys in braces`);
	}
	for (const [key, subValue] of Object.entries(value)) {
		if (!knownKeys.includes(key)) {
			throw new SettingsError(
				file,
				`unknown key "${block}.${key}". Known keys in "${block}": ${knownKeys.join(", ")}`,
			);
		}
		apply(`${block}.${key}`, subValue);
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolean(value: unknown, file: string, key: string): boolean {
	if (typeof value === "boolean") return value;
	throw new SettingsError(file, `"${key}" must be true or false`);
}

function readText(value: unknown, file: string, key: string): string {
	if (typeof value === "string" && value.trim() !== "") return value;
	throw new SettingsError(file, `"${key}" must be text that is not empty`);
}

function readPath(value: unknown, file: string, key: string): string {
	const path = readText(value, file, key);
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function readChoice<T extends string>(
	value: unknown,
	file: string,
	key: string,
	choices: readonly T[],
): T {
	if (typeof value === "string" && (choices as readonly string[]).includes(value)) {
		return value as T;
	}
	throw new SettingsError(file, `"${key}" must be one of: ${choices.join(", ")}`);
}

function readWholeNumber(value: unknown, file: string, key: string, min: number): number {
	if (typeof value === "number" && Number.isInteger(value) && value >= min) return value;
	throw new SettingsError(file, `"${key}" must be a whole number, ${min} or more`);
}

function readDelayList(value: unknown, file: string): number[] {
	if (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((entry) => typeof entry === "number" && Number.isInteger(entry) && entry >= 0)
	) {
		return [...value];
	}
	throw new SettingsError(
		file,
		'"provider-recovery-delays-ms" must be a list of whole millisecond numbers, ' +
			"for example [30000, 60000, 90000]",
	);
}

const DURATION_UNIT_MS: Record<string, number> = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

function readDurationMs(value: unknown, file: string, key: string): number {
	if (typeof value === "string") {
		const match = value
			.trim()
			.toLowerCase()
			.match(/^(\d+)(ms|s|m|h|d)$/);
		if (match) return Number(match[1]) * DURATION_UNIT_MS[match[2]];
	}
	throw new SettingsError(
		file,
		`"${key}" must be a duration with a unit — ms, s, m, h, or d — for example "30s" or "14d"`,
	);
}

const SIZE_UNIT_BYTES: Record<string, number> = {
	b: 1,
	kb: 1024,
	kib: 1024,
	mb: 1024 * 1024,
	mib: 1024 * 1024,
	gb: 1024 * 1024 * 1024,
	gib: 1024 * 1024 * 1024,
};

function readSizeBytes(value: unknown, file: string, key: string): number {
	if (typeof value === "string") {
		const match = value
			.trim()
			.toLowerCase()
			.match(/^(\d+)(b|kb|kib|mb|mib|gb|gib)$/);
		if (match) return Number(match[1]) * SIZE_UNIT_BYTES[match[2]];
	}
	throw new SettingsError(
		file,
		`"${key}" must be a size with a unit — b, kb, kib, mb, mib, gb, or gib — ` +
			'for example "500mb" or "1gib"',
	);
}
