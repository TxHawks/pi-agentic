import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionHandler,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
	getAgentListEntries,
	getAgentListSignature,
	renderAgentListReminder,
} from "../../src/agents/agent-list.ts";
import type { getEffectiveAgentDefinitions } from "../../src/agents/definitions.ts";
import subagentsExtension from "../../src/subagents.ts";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	it,
	join,
	mkdirSync,
	resetSubagentStateForTest,
	writeFileSync,
} from "../support/index.ts";

function writeAgents(dir: string): string {
	const configDir = join(dir, "agent-root");
	const agentsDir = join(configDir, "agents");
	mkdirSync(agentsDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = configDir;
	writeFileSync(
		join(agentsDir, "public.md"),
		`---\nname: public\ndescription: Public worker\nvisible-to: all\n---\n\nPublic body.`,
	);
	writeFileSync(
		join(agentsDir, "root-only.md"),
		`---\nname: root-only\ndescription: Root worker\nvisible-to: root\n---\n\nRoot body.`,
	);
	writeFileSync(
		join(agentsDir, "other-only.md"),
		`---\nname: other-only\ndescription: Caller worker\nvisible-to: caller-agent\nspawning: scout, reviewer\nspawn-depth: 2\nspawn-width: 3\n---\n\nCaller body.`,
	);
	return agentsDir;
}

function resolveSessionMode(agent: ReturnType<typeof getEffectiveAgentDefinitions>[number]) {
	return agent.sessionMode ?? "lineage-only";
}

describe("roster filtering", () => {
	afterEach(() => resetSubagentStateForTest());

	it("filters root and child rosters by visibility and caller whitelist", () => {
		const dir = createTestDir();
		writeAgents(dir);

		const root = getAgentListEntries(dir, resolveSessionMode, {
			callerAgent: null,
			callerSpawnable: true,
		});
		assert.deepEqual(
			root.map((entry) => entry.name),
			["public", "root-only"],
		);

		const child = getAgentListEntries(dir, resolveSessionMode, {
			callerAgent: "caller-agent",
			callerSpawnable: ["public", "other-only", "root-only"],
		});
		assert.deepEqual(
			child.map((entry) => entry.name),
			["other-only", "public"].sort(),
		);
		const reminder = renderAgentListReminder(child);
		assert.match(reminder, /`other-only`: Caller worker/);
		assert.doesNotMatch(reminder, /root-only/);
	});

	it("renders spawning grants and includes visibility changes in the signature", () => {
		const dir = createTestDir();
		const agentsDir = writeAgents(dir);
		const options = { callerAgent: "caller-agent", callerSpawnable: true as const };
		const before = getAgentListEntries(dir, resolveSessionMode, options);
		const reminder = renderAgentListReminder(before);
		assert.match(reminder, /spawning: scout, reviewer/);
		assert.match(reminder, /spawn-depth: 2/);
		assert.match(reminder, /spawn-width: 3/);

		const signature = getAgentListSignature(before);
		writeFileSync(
			join(agentsDir, "other-only.md"),
			`---\nname: other-only\ndescription: Caller worker\nvisible-to: all\nspawning: scout, reviewer\nspawn-depth: 2\nspawn-width: 3\n---\n\nCaller body.`,
		);
		assert.notEqual(
			signature,
			getAgentListSignature(getAgentListEntries(dir, resolveSessionMode, options)),
		);
	});

	it("emits a superseding no-agents reminder when filtering empties a roster", () => {
		const dir = createTestDir();
		writeAgents(dir);
		process.env.PI_SUBAGENT_AGENT = "hidden-child";
		process.env.PI_SUBAGENT_SPAWNABLE = "missing-agent";
		type Handler =
			| ExtensionHandler<SessionStartEvent>
			| ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;
		const handlers = new Map<string, Handler>();
		const pi = {
			on(event: string, handler: Handler) {
				handlers.set(event, handler);
			},
			registerTool() {},
			registerCommand() {},
			registerMessageRenderer() {},
			getThinkingLevel: () => "low",
		};
		// @ts-expect-error This test supplies only the API methods used by these hooks.
		subagentsExtension(pi);

		const sessionStart = handlers.get("session_start") as
			| ExtensionHandler<SessionStartEvent>
			| undefined;
		assert.ok(sessionStart);
		const context = {
			cwd: dir,
			hasUI: false,
			ui: { setWidget() {} },
			sessionManager: {
				getHeader: () => ({ id: "child", type: "session", timestamp: "", cwd: dir }),
			},
		};
		// @ts-expect-error The startup hook only needs the context fields supplied here.
		sessionStart({ type: "session_start", reason: "startup" }, context);
		const beforeAgentStart = handlers.get("before_agent_start") as
			| ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>
			| undefined;
		assert.ok(beforeAgentStart);
		// @ts-expect-error Roster refresh does not need the prompt or context arguments.
		const result = beforeAgentStart({ type: "before_agent_start" }) as {
			message: { content: string; details: { supersedes: boolean } };
		};
		assert.ok(result?.message);
		assert.equal(result.message.details.supersedes, true);
		assert.match(result.message.content, /No agents are spawnable in this session/);
		assert.doesNotMatch(result.message.content, /root-only|other-only|public/);
	});
});
