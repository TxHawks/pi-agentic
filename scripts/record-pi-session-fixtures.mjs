#!/usr/bin/env node
// Record real Pi SessionManager JSONL in test/fixtures/pi-sessions/.
// This script never uses stdout events as a session fixture.
//
// Usage:
//   node scripts/record-pi-session-fixtures.mjs --model <provider/model[:thinking]>
//   node scripts/record-pi-session-fixtures.mjs --scenario provider-error
//
// Ask the user for model refs (docs/agents/live-testing.md). There is no default.
// Pi resolves each ref. The saved session records the actual provider and model.
// --extension <path> and --copy <file-name> support extension-owned providers,
// as in record-pi-event-fixtures.mjs. Both flags can repeat.
//
// The temporary fixture extension supplies caller_ping and completion markers.
// It does not change model messages or usage. The context-pressure scenario
// forces that marker reason; it does NOT prove real context-window pressure.
// Provider-error uses a closed local port, with no user provider or extension.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piBinary = join(repoRoot, "node_modules", ".bin", "pi");
const fixturesDir = join(repoRoot, "test", "fixtures", "pi-sessions");
const recorder = "scripts/record-pi-session-fixtures.mjs";
const brokenModel = "fixture-broken/fixture-model";
const pingMessage = "Fixture help: confirm the next step.";
const runTimeoutMs = 180_000;
const scenarios = {
	"tool-ping": {
		completionReason: "normal",
		tools: "read,caller_ping",
		prompt: [
			"First call read on probe.txt. Wait for its result.",
			`Then call caller_ping with exactly {"message":${JSON.stringify(pingMessage)}}.`,
			"Do not call both tools together. Do not use other tools.",
		].join(" "),
	},
	"context-pressure": {
		completionReason: "context-pressure",
		tools: "",
		prompt: 'Reply with exactly: "The fixture report is complete."',
	},
	"provider-error": {
		broken: true,
		tools: "",
		prompt: "Say hello.",
	},
};

function parseArgs(argv) {
	const args = { model: undefined, scenario: undefined, extensions: [], copies: [] };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (!["--model", "--scenario", "--extension", "--copy"].includes(flag)) {
			throw new Error(`Unknown argument: ${flag}`);
		}
		const value = argv[++index];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
		if (flag === "--model") args.model = value;
		else if (flag === "--scenario") args.scenario = value;
		else if (flag === "--extension") args.extensions.push(resolve(value));
		else {
			if (basename(value) !== value || value === "." || value === "..") {
				throw new Error("--copy needs a file name in the user's Pi home, not a path");
			}
			args.copies.push(value);
		}
	}
	if (args.scenario && !Object.hasOwn(scenarios, args.scenario)) {
		throw new Error(`Unknown scenario: ${args.scenario}. Use ${Object.keys(scenarios).join(", ")}`);
	}
	if (!args.model && args.scenario !== "provider-error") {
		throw new Error(`Usage: node ${recorder} --model <provider/model[:thinking]>`);
	}
	return args;
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function sha256(content) {
	return createHash("sha256").update(content).digest("hex");
}

function makePiHome(root, { broken }, copies) {
	const home = join(root, "home");
	mkdirSync(home, { mode: 0o700 });
	writeJson(join(home, "settings.json"), {
		retry: { maxRetries: 2, baseDelayMs: 250 },
		compaction: { enabled: false },
		enableInstallTelemetry: false,
	});
	if (broken) {
		writeJson(join(home, "models.json"), {
			providers: {
				"fixture-broken": {
					baseUrl: "http://127.0.0.1:9/v1",
					apiKey: "fixture-key",
					api: "openai-completions",
					models: [{ id: "fixture-model", contextWindow: 8192, maxTokens: 512 }],
				},
			},
		});
	} else {
		const userHome = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
		for (const name of new Set(["auth.json", "models.json", ...copies])) {
			const source = join(userHome, name);
			if (!existsSync(source)) {
				if (copies.includes(name)) throw new Error(`Missing requested config file: ${name}`);
				continue;
			}
			const destination = join(home, name);
			copyFileSync(source, destination);
			chmodSync(destination, 0o600);
		}
	}
	return home;
}

function childEnv(home) {
	/** @type {NodeJS.ProcessEnv} */
	const env = { ...process.env, PI_CODING_AGENT_DIR: home, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
	for (const key of Object.keys(env)) {
		if (key.startsWith("PI_SUBAGENT_")) delete env[key];
	}
	delete env.PI_PACKAGE_DIR;
	delete env.PI_DENY_TOOLS;
	delete env.PI_ORCHESTRATOR_MODE;
	return env;
}

function fixtureExtension(name, scenario) {
	return `// Temporary recording helper, not the pi-agentic child protocol.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		pi.appendEntry("pi-session-fixture-origin", {
			recorder: ${JSON.stringify(recorder)},
			scenario: ${JSON.stringify(name)},
			completionMarker: "fixture-extension",
			contextPressureForced: ${name === "context-pressure"},
		});
	});
	pi.registerTool({
		name: "caller_ping",
		label: "Fixture caller ping",
		description: "Record a message for the parent in this fixture session.",
		parameters: Type.Object({ message: Type.String() }),
		async execute(_id, params) {
			return {
				content: [{ type: "text", text: "Fixture ping recorded." }],
				details: { origin: "fixture-extension", message: params.message },
			};
		},
	});
	pi.on("agent_settled", (_event, ctx) => {
		const last = ctx.sessionManager.getEntries().filter(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		).at(-1);
		if (!last || last.type !== "message" || last.message.role !== "assistant") return;
		if (last.message.stopReason === "error" || last.message.stopReason === "aborted") return;
		pi.appendEntry("pi-subagent-completion", { reason: ${JSON.stringify(scenario.completionReason)} });
	});
}
`;
}

function recordScenario(name, scenario, args, tmpRoot) {
	const root = join(tmpRoot, name);
	const workDir = join(root, "work");
	const sessionDir = join(root, "sessions");
	mkdirSync(workDir, { recursive: true });
	mkdirSync(sessionDir);
	writeFileSync(join(workDir, "probe.txt"), "fixture-tool-probe\n");
	const home = makePiHome(root, scenario, args.copies);
	const sessionPath = join(sessionDir, "recording.jsonl");
	const extensionSource = scenario.broken ? undefined : fixtureExtension(name, scenario);
	const extensions = scenario.broken ? [] : args.extensions;
	const flags = [];
	if (extensionSource) {
		const extensionPath = join(root, "fixture-extension.ts");
		writeFileSync(extensionPath, extensionSource);
		flags.push("-e", extensionPath);
	}
	for (const path of extensions) flags.push("-e", path);
	const model = scenario.broken ? brokenModel : args.model;
	const argv = [
		"-p",
		"--mode",
		"json",
		"--model",
		model,
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--no-approve",
		"--session-dir",
		sessionDir,
		"--session",
		sessionPath,
		...(scenario.tools ? ["--tools", scenario.tools] : ["--no-tools"]),
		...flags,
		scenario.prompt,
	];
	console.log(`recording ${name} with ${model} ...`);
	try {
		// Stdout is not the fixture. Only SessionManager's file is copied below.
		execFileSync(piBinary, argv, {
			cwd: workDir,
			env: childEnv(home),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: runTimeoutMs,
			maxBuffer: 16 * 1024 * 1024,
		});
	} catch (error) {
		const stderr = typeof error?.stderr === "string" ? error.stderr.slice(-2000) : "";
		throw new Error(`Pi failed while recording ${name}.\n${stderr}`, { cause: error });
	}
	const raw = readFileSync(sessionPath);
	return { raw, model, extensionSource, extensions };
}

function validateSession(name, scenario, raw) {
	const entries = raw.toString("utf8").trimEnd().split("\n").map(JSON.parse);
	assert.equal(entries[0]?.type, "session", "Missing session header");
	assert.equal(entries[0]?.version, 3, "Review the recorder for a new session format");
	for (const entry of entries.slice(1)) {
		assert.equal(typeof entry.id, "string", "Not a SessionManager entry");
		assert.ok(Object.hasOwn(entry, "parentId"), "Not a SessionManager entry");
	}
	const assistants = entries
		.filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
		.map((entry) => entry.message);
	assert.ok(assistants.length > 0, "No recorded assistant messages");
	const outputs = assistants.map((message) => message.usage?.output);
	assert.ok(outputs.every((output) => Number.isInteger(output) && output >= 0));
	const last = assistants.at(-1);
	const pings = assistants.flatMap((message) =>
		message.content.filter((block) => block.type === "toolCall" && block.name === "caller_ping"),
	);
	const markers = entries.filter(
		(entry) => entry.type === "custom" && entry.customType === "pi-subagent-completion",
	);
	if (scenario.broken) {
		assert.equal(last.stopReason, "error");
		assert.equal(typeof last.errorMessage, "string");
		assert.ok(last.errorMessage.length > 0);
		assert.equal(markers.length, 0);
	} else {
		assert.ok(assistants.every((message) => !["error", "aborted"].includes(message.stopReason)));
		assert.deepEqual(
			markers.map((marker) => marker.data),
			[{ reason: scenario.completionReason }],
		);
		assert.ok(outputs.reduce((sum, output) => sum + output, 0) > 0);
		if (name === "tool-ping") {
			assert.ok(assistants.length >= 2, "Need at least two assistant usage records");
			assert.deepEqual(
				pings.map((ping) => ping.arguments),
				[{ message: pingMessage }],
			);
			assert.ok(
				entries.some(
					(entry) =>
						entry.type === "message" &&
						entry.message?.role === "toolResult" &&
						entry.message.toolName === "read" &&
						entry.message.isError === false,
				),
			);
			assert.ok(
				entries.some(
					(entry) =>
						entry.type === "message" &&
						entry.message?.role === "toolResult" &&
						entry.message.toolName === "caller_ping" &&
						entry.message.isError === false,
				),
			);
		}
	}
	return {
		model: `${last.provider}/${last.model}`,
		api: last.api,
		assistantCount: assistants.length,
		outputTokens: outputs,
		totalOutputTokens: outputs.reduce((sum, output) => sum + output, 0),
		pingArguments: pings.map((ping) => ping.arguments),
		completionReasons: markers.map((marker) => marker.data.reason),
		terminalStopReason: last.stopReason,
		terminalError: last.errorMessage ?? null,
	};
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const names = args.scenario ? [args.scenario] : Object.keys(scenarios);
	const piVersion = execFileSync(piBinary, ["--version"], { encoding: "utf8" }).trim();
	const tmpRoot = mkdtempSync(join(tmpdir(), "pi-session-fixtures-"));
	try {
		for (const name of names) {
			const scenario = scenarios[name];
			const { raw, model, extensionSource, extensions } = recordScenario(
				name,
				scenario,
				args,
				tmpRoot,
			);
			const evidence = validateSession(name, scenario, raw);
			const modelDir = evidence.model
				.split("/")
				.map((part) => encodeURIComponent(part))
				.join("/");
			const outputDir = scenario.broken ? fixturesDir : join(fixturesDir, modelDir);
			mkdirSync(outputDir, { recursive: true });
			writeFileSync(join(outputDir, `${name}.jsonl`), raw);
			writeJson(join(outputDir, `${name}.meta.json`), {
				scenario: name,
				source: "recorded",
				format: "Pi SessionManager JSONL (not stdout events)",
				piVersion,
				requestedModel: model,
				model: evidence.model,
				recordedAt: new Date().toISOString(),
				recorder,
				rawSessionSha256: sha256(raw),
				transforms: [],
				fixtureExtension: extensionSource
					? {
							origin: recorder,
							sha256: sha256(extensionSource),
							callerPing: "Temporary tool; records real model arguments and allows a final reply.",
							completionMarker: "Temporary extension calls pi.appendEntry after agent_settled.",
							contextPressureForced: name === "context-pressure",
						}
					: null,
				providerExtensions: extensions.map((path) => ({
					file: basename(path),
					sha256: sha256(readFileSync(path)),
				})),
				localProviderError: scenario.broken
					? "Closed local port http://127.0.0.1:9/v1; no model output is generated."
					: null,
				evidence,
			});
			console.log(
				`${name}: ${model} -> ${evidence.model}; output tokens ${evidence.totalOutputTokens}`,
			);
			console.log(`wrote ${join(outputDir, `${name}.jsonl`)}`);
		}
	} finally {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
