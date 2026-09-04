#!/usr/bin/env node
// Regenerate the recorded Pi event fixtures in test/fixtures/pi-events/.
//
// Each recorded fixture is the raw stdout stream of one `pi -p --mode json`
// child, run with the Pi version this repo pins in node_modules. The script
// writes one `<scenario>.jsonl` stream and one `<scenario>.meta.json` meta
// file that states the Pi version the stream came from.
//
// Usage:
//   node scripts/record-pi-event-fixtures.mjs --model <provider/model[:thinking]>
//   node scripts/record-pi-event-fixtures.mjs --model <ref> --scenario thinking
//   node scripts/record-pi-event-fixtures.mjs --model <ref> --keep-tmp
//
// Model refs are user-owned (see docs/agents/live-testing.md): ask the user
// which ref to record with. The provider-error scenario needs no real model:
// it runs against a local provider entry that points at a closed port.
//
// When the model's provider comes from an extension, pass the extension file
// with --extension, and copy its config file into the recording home with
// --copy <file-name>. Both flags can repeat.
//
// The two synthetic fixtures (synthetic-torn-tail, synthetic-malformed-lines)
// are hand-built broken streams. This script never writes them.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piBinary = join(repoRoot, "node_modules", ".bin", "pi");
const fixturesDir = join(repoRoot, "test", "fixtures", "pi-events");

const BROKEN_MODEL_REF = "fixture-broken/fixture-model";
const RUN_TIMEOUT_MS = 180_000;

function deltaType(event) {
	return event?.type === "message_update" ? event.assistantMessageEvent?.type : undefined;
}

function assistantUsage(event) {
	if (event?.type !== "message_end" || event.message?.role !== "assistant") return undefined;
	return event.message.usage;
}

const SCENARIOS = {
	"assistant-text": {
		flags: ["--no-tools"],
		prompt: 'Reply with exactly this sentence and nothing else: "The fixture stream works."',
		evidence: {
			"a text_delta message_update": (events) => events.some((e) => deltaType(e) === "text_delta"),
			"an assistant message_end with token usage": (events) =>
				events.some((e) => {
					const usage = assistantUsage(e);
					return typeof usage?.input === "number" && typeof usage?.output === "number";
				}),
		},
	},
	thinking: {
		flags: ["--no-tools"],
		thinking: "medium",
		prompt: "Think first, then answer in one sentence: why does ice float on water?",
		evidence: {
			"a thinking_delta message_update (use a model that supports thinking)": (events) =>
				events.some((e) => deltaType(e) === "thinking_delta"),
		},
	},
	"tool-calls": {
		flags: ["--tools", "bash"],
		prompt: "Run the bash command `echo fixture-tool-probe`, then reply with only its output.",
		evidence: {
			"a toolcall_start message_update": (events) =>
				events.some((e) => deltaType(e) === "toolcall_start"),
			"a tool_execution_start event": (events) =>
				events.some((e) => e.type === "tool_execution_start"),
			"a tool_execution_end event": (events) => events.some((e) => e.type === "tool_execution_end"),
		},
	},
	"provider-error": {
		flags: ["--no-tools"],
		broken: true,
		prompt: "Say hello.",
		evidence: {
			"an auto_retry_start event": (events) => events.some((e) => e.type === "auto_retry_start"),
			"a failed auto_retry_end event": (events) =>
				events.some((e) => e.type === "auto_retry_end" && e.success === false),
			"a message_end with stopReason error": (events) =>
				events.some((e) => e.type === "message_end" && e.message?.stopReason === "error"),
		},
	},
};

function parseArgs(argv) {
	const args = {
		model: undefined,
		scenario: undefined,
		keepTmp: false,
		extensions: [],
		copies: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--model") args.model = argv[++i];
		else if (arg === "--scenario") args.scenario = argv[++i];
		else if (arg === "--extension") args.extensions.push(resolve(argv[++i]));
		else if (arg === "--copy") args.copies.push(argv[++i]);
		else if (arg === "--keep-tmp") args.keepTmp = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return args;
}

function usage() {
	return [
		"Usage: node scripts/record-pi-event-fixtures.mjs --model <provider/model[:thinking]>",
		"  --scenario <name>  Regenerate one scenario only. Names:",
		`                     ${Object.keys(SCENARIOS).join(", ")}`,
		"  --extension <path> Load an extension file in the child (for providers",
		"                     that an extension registers). Can repeat.",
		"  --copy <file>      Copy a named config file from the user's Pi home into",
		"                     the recording home (for extension config). Can repeat.",
		"  --keep-tmp         Keep the temporary Pi home for inspection.",
	].join("\n");
}

/** Build one temporary Pi home. The child never reads the user's real home. */
function makePiHome(tmpRoot, name, { broken, copies }) {
	const home = join(tmpRoot, name);
	mkdirSync(home, { recursive: true });
	writeFileSync(
		join(home, "settings.json"),
		`${JSON.stringify({ retry: { maxRetries: 2, baseDelayMs: 250 } }, null, "\t")}\n`,
	);
	if (broken) {
		// A provider on a closed local port: every request fails with a
		// connection error, which Pi retries and then reports as an error stop.
		const providers = {
			"fixture-broken": {
				name: "Fixture broken provider",
				baseUrl: "http://127.0.0.1:9/v1",
				apiKey: "fixture-key",
				api: "openai-completions",
				models: [{ id: "fixture-model", contextWindow: 8192, maxTokens: 512 }],
			},
		};
		writeFileSync(join(home, "models.json"), `${JSON.stringify({ providers }, null, "\t")}\n`);
		return home;
	}
	const userHome = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	for (const file of ["auth.json", "models.json", ...copies]) {
		const source = join(userHome, file);
		if (existsSync(source)) copyFileSync(source, join(home, file));
	}
	return home;
}

function childEnv(piHome) {
	const env = { ...process.env, PI_CODING_AGENT_DIR: piHome };
	for (const key of Object.keys(env)) {
		if (key.startsWith("PI_SUBAGENT_")) delete env[key];
	}
	delete env.PI_PACKAGE_DIR;
	delete env.PI_DENY_TOOLS;
	return env;
}

function recordScenario(name, scenario, { tmpRoot, model, extensions, copies }) {
	const broken = scenario.broken === true;
	const piHome = makePiHome(tmpRoot, `home-${name}`, { broken, copies });
	const workDir = join(tmpRoot, `work-${name}`);
	const sessionDir = join(tmpRoot, `sessions-${name}`);
	mkdirSync(workDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	const modelRef = broken ? BROKEN_MODEL_REF : model;
	const flags = [...scenario.flags];
	if (scenario.thinking && !modelRef.includes(":")) {
		flags.push("--thinking", scenario.thinking);
	}
	// The broken-provider home is self-contained; user extensions stay out of
	// that stream so the error fixture is the same for every recording user.
	if (!broken) {
		for (const path of extensions) flags.push("-e", path);
	}
	const argv = [
		"-p",
		"--mode",
		"json",
		"--model",
		modelRef,
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--session-dir",
		sessionDir,
		...flags,
		scenario.prompt,
	];
	console.log(`recording ${name} with ${modelRef} ...`);
	let stdout;
	try {
		stdout = execFileSync(piBinary, argv, {
			cwd: workDir,
			env: childEnv(piHome),
			encoding: "utf8",
			timeout: RUN_TIMEOUT_MS,
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch (error) {
		const tail = typeof error?.stderr === "string" ? error.stderr.slice(-2000) : "";
		throw new Error(`pi exited with an error while recording ${name}.\n${tail}`, { cause: error });
	}
	return { stream: stdout, modelRef };
}

function validateStream(name, scenario, stream) {
	const lines = stream.split("\n").filter((line) => line.length > 0);
	const events = lines.map((line, index) => {
		try {
			return JSON.parse(line);
		} catch (error) {
			throw new Error(`${name}: line ${index + 1} of the stream is not JSON`, { cause: error });
		}
	});
	const missing = [];
	if (events[0]?.type !== "session") missing.push("the session header as the first line");
	if (!events.some((e) => e.type === "agent_end")) missing.push("an agent_end event");
	if (!events.some((e) => e.type === "agent_settled")) missing.push("an agent_settled event");
	for (const [label, present] of Object.entries(scenario.evidence)) {
		if (!present(events)) missing.push(label);
	}
	if (missing.length > 0) {
		throw new Error(
			`${name}: the recorded stream is missing required evidence:\n- ${missing.join("\n- ")}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

function writeFixture(name, stream, meta) {
	mkdirSync(fixturesDir, { recursive: true });
	writeFileSync(join(fixturesDir, `${name}.jsonl`), stream);
	writeFileSync(join(fixturesDir, `${name}.meta.json`), `${JSON.stringify(meta, null, "\t")}\n`);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.scenario && !(args.scenario in SCENARIOS)) {
		console.error(`Unknown scenario: ${args.scenario}\n\n${usage()}`);
		process.exit(1);
	}
	const names = args.scenario ? [args.scenario] : Object.keys(SCENARIOS);
	const needsModel = names.some((name) => SCENARIOS[name].broken !== true);
	if (needsModel && !args.model) {
		console.error(`--model is required.\n\n${usage()}`);
		process.exit(1);
	}
	const piVersion = execFileSync(piBinary, ["--version"], { encoding: "utf8" }).trim();
	const tmpRoot = mkdtempSync(join(tmpdir(), "pi-event-fixtures-"));
	try {
		for (const name of names) {
			const scenario = SCENARIOS[name];
			const { stream, modelRef } = recordScenario(name, scenario, {
				tmpRoot,
				model: args.model,
				extensions: args.extensions,
				copies: args.copies,
			});
			const normalized = validateStream(name, scenario, stream);
			writeFixture(name, normalized, {
				scenario: name,
				source: "recorded",
				piVersion,
				model: modelRef,
				recordedAt: new Date().toISOString(),
			});
			console.log(`wrote ${join("test", "fixtures", "pi-events", `${name}.jsonl`)}`);
		}
	} finally {
		if (args.keepTmp) console.error(`kept temp dir: ${tmpRoot}`);
		else rmSync(tmpRoot, { recursive: true, force: true });
	}
	console.log(`done: ${names.length} fixture(s) recorded with Pi ${piVersion}`);
}

main();
