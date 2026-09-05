import {
	type AgentDefaults,
	getEffectiveAgentDefinitions,
	loadAgentDefaults,
} from "../../agents/definitions.ts";
import { completedSubagentResults, runningSubagents } from "../../runtime/state.ts";
import { stopRunningSubagent } from "../../runtime/wiring.ts";
import { getEntries } from "../../session/session.ts";
import {
	type PersistedSubagentLaunchMetadata,
	readSubagentLaunchMetadata,
} from "../../session/session-files.ts";
import type { CompletedSubagentResult, RunningSubagent } from "../../types.ts";
import {
	compactStats,
	completedRuntimeSection,
	readCompletedSessionStats,
	recoverResultDetails,
	recoverSummary,
	statusVisuals,
} from "./completed-session.ts";
import { compactCount, firstLine, formatElapsed, formatElapsedSeconds } from "./render-helpers.ts";
import type { DetailSection, OverlayContext, OverlayItem } from "./render-types.ts";

// ─── Section building ───────────────────────────────────────────────────────

type AgentDetailDefaults = AgentDefaults & {
	name?: string;
	description?: string;
};

const SECTION_FIELDS = [
	{
		title: "Identity",
		fields: ["name", "description", "agent file"],
	},
	{
		title: "Runtime",
		fields: [
			"mode",
			"session-mode",
			"async",
			"auto-exit",
			"parent-close",
			"no-session",
			"timeout",
			"launched",
		],
	},
	{
		title: "Model",
		fields: [
			"model",
			"thinking",
			"resolved",
			"allow-model-override",
			"override-model",
			"override-thinking",
		],
	},
	{
		title: "Workspace",
		fields: ["cwd", "trust-project", "flags", "env"],
	},
	{
		title: "Capabilities",
		fields: [
			"tools",
			"deny-tools",
			"extensions",
			"skills",
			"inject-skills",
			"spawning",
			"no-context-files",
			"inherit-append-system",
		],
	},
];

function none(value?: string | null): string {
	return value?.trim() ? value : "none";
}

function inherited(value?: string | null): string {
	return value?.trim() ? value : "default";
}

function buildSections(
	defs: AgentDetailDefaults | null,
	meta?: PersistedSubagentLaunchMetadata,
): DetailSection[] {
	const fields: Array<{ label: string; value: string }> = [];
	const name = meta?.name ?? defs?.name ?? "—";

	fields.push({ label: "name", value: name });
	fields.push({ label: "description", value: defs?.description ?? "—" });
	fields.push({ label: "agent file", value: defs?.path ?? "—" });
	if (meta) {
		fields.push({
			label: "launched",
			value: meta.timestamp ? new Date(meta.timestamp).toLocaleString() : "—",
		});
	}
	fields.push({
		label: "model",
		value: inherited(meta?.definitionModel ?? defs?.model ?? meta?.model),
	});
	fields.push({
		label: "thinking",
		value: inherited(meta?.definitionThinking ?? defs?.thinking ?? meta?.thinking),
	});
	if (meta?.modelRef) {
		fields.push({ label: "resolved", value: meta.modelRef });
	}
	fields.push({
		label: "allow-model-override",
		value: String(meta ? meta.allowModelOverride === true : defs?.allowModelOverride === true),
	});
	if (meta?.modelSource === "launch-override" || meta?.modelSource === "resume-override") {
		fields.push({ label: "override-model", value: inherited(meta.model) });
		fields.push({
			label: "override-thinking",
			value: inherited(meta.thinking),
		});
	}
	fields.push({
		label: "mode",
		value: meta?.mode ?? defs?.mode ?? "interactive",
	});
	fields.push({ label: "cwd", value: meta?.cwd ?? defs?.cwd ?? "parent cwd" });
	fields.push({
		label: "trust-project",
		value: String(meta ? (meta.trustProject ?? false) : (defs?.trustProject ?? false)),
	});
	fields.push({ label: "flags", value: none(meta?.flags ?? defs?.flags) });
	fields.push({ label: "env", value: none(meta?.env ?? defs?.env) });
	fields.push({ label: "tools", value: meta?.tools ?? defs?.tools ?? "all" });
	fields.push({ label: "deny-tools", value: none(defs?.denyTools) });
	fields.push({
		label: "extensions",
		value: meta?.extensions?.length ? meta.extensions.join(", ") : "all",
	});
	fields.push({
		label: "skills",
		value: meta?.skills ?? defs?.skills ?? "all",
	});
	fields.push({
		label: "inject-skills",
		value: none(meta?.injectSkills ?? defs?.injectSkills),
	});
	fields.push({
		label: "spawning",
		value: Array.isArray(defs?.spawning)
			? defs.spawning.join(",")
			: String(defs?.spawning ?? false),
	});
	fields.push({
		label: "no-context-files",
		value: String(meta ? meta.noContextFiles : (defs?.noContextFiles ?? false)),
	});
	fields.push({
		label: "inherit-append-system",
		value: String(
			meta ? (meta.inheritAppendSystem ?? false) : (defs?.inheritAppendSystem ?? false),
		),
	});
	fields.push({
		label: "async",
		value: String(meta ? meta.async : (defs?.async ?? true)),
	});
	fields.push({
		label: "auto-exit",
		value: String(meta ? (meta.autoExit ?? false) : (defs?.autoExit ?? false)),
	});
	fields.push({
		label: "session-mode",
		value: (meta?.sessionMode ?? defs?.sessionMode ?? "lineage-only") as string,
	});
	fields.push({
		label: "parent-close",
		value: (meta?.parentClosePolicy ?? defs?.parentClosePolicy ?? "terminate") as string,
	});
	fields.push({
		label: "no-session",
		value: String(meta ? meta.noSession : (defs?.noSession ?? false)),
	});
	const wallClock = meta?.timeout ?? defs?.timeout;
	const idle = meta?.idleTimeout ?? defs?.idleTimeout;
	const budgets = [wallClock ? `${wallClock}s` : "", idle ? `idle ${idle}s` : ""].filter(Boolean);
	const onTimeout = (meta?.onTimeout ?? defs?.onTimeout ?? "report") as string;
	fields.push({
		label: "timeout",
		value: budgets.length ? `${budgets.join(" / ")} (${onTimeout})` : "none",
	});

	return SECTION_FIELDS.map((section) => ({
		title: section.title,
		fields: section.fields
			.map((label) => fields.find((field) => field.label === label))
			.filter((field): field is { label: string; value: string } => Boolean(field)),
	})).filter((section) => section.fields.length > 0);
}

function buildRuntimeSection(
	isRunning: boolean,
	r: RunningSubagent | CompletedSubagentResult,
): DetailSection {
	const fields: Array<{ label: string; value: string }> = [];
	const running = r as RunningSubagent;
	const completed = r as CompletedSubagentResult;

	if (isRunning && running.startTime) {
		fields.push({ label: "elapsed", value: formatElapsed(running.startTime) });
	} else if (completed.elapsed != null) {
		fields.push({ label: "elapsed", value: `${completed.elapsed}s` });
	}
	if (running.messageCount != null)
		fields.push({ label: "messages", value: `${running.messageCount}` });
	if (running.toolUses != null) fields.push({ label: "tool uses", value: `${running.toolUses}` });

	const ctxUsed = running.contextTokens ?? 0;
	const ctxW = running.modelContextWindow;
	if (ctxUsed > 0 && ctxW) {
		fields.push({
			label: "context",
			value: `${compactCount(ctxUsed)}/${compactCount(ctxW)}`,
		});
	} else if (running.contextLabel) {
		fields.push({ label: "context", value: running.contextLabel });
	} else if ((running.contextTokens ?? 0) > 0) {
		fields.push({
			label: "tokens",
			value: compactCount(running.contextTokens ?? 0),
		});
	}

	if (running.activity) fields.push({ label: "activity", value: running.activity });
	if (running.sessionFile) fields.push({ label: "session", value: running.sessionFile });
	if (running.surface) fields.push({ label: "pane", value: running.surface });
	if (running.childProcess?.pid)
		fields.push({ label: "PID", value: `${running.childProcess.pid}` });

	return { title: "Runtime", fields };
}

// ─── Safe helpers ───────────────────────────────────────────────────────────

function safeMeta(f: string): PersistedSubagentLaunchMetadata | undefined {
	try {
		return readSubagentLaunchMetadata(f);
	} catch {
		return undefined;
	}
}

function safeDefs(a: string, cwd: string): AgentDetailDefaults | null {
	try {
		return loadAgentDefaults(a, undefined, cwd, (_h, b) => b);
	} catch {
		return null;
	}
}

// ─── Public item builders ───────────────────────────────────────────────────

export function buildRunningItems(ctx: OverlayContext): OverlayItem[] {
	const items: OverlayItem[] = [];
	for (const a of runningSubagents.values()) {
		const meta = safeMeta(a.sessionFile);
		const defs = a.agent ? safeDefs(a.agent, ctx.cwd) : null;
		const sections = buildSections(defs, meta);
		sections.push(buildRuntimeSection(true, a));

		const stats: string[] = [];
		const modelRef = a.modelRef ?? meta?.modelRef;
		if (a.toolUses) stats.push(`${a.toolUses} tool${a.toolUses === 1 ? "" : "s"}`);
		const ctxUsed = a.contextTokens ?? 0;
		if (ctxUsed > 0 && a.modelContextWindow) {
			stats.push(`${compactCount(ctxUsed)}/${compactCount(a.modelContextWindow)} ctx`);
		} else if (a.contextLabel) {
			stats.push(a.contextLabel);
		} else if ((a.contextTokens ?? 0) > 0) {
			stats.push(`${compactCount(a.contextTokens ?? 0)} tokens`);
		}
		stats.push(formatElapsed(a.startTime));

		items.push({
			id: a.id,
			icon: "●",
			iconColor: "accent",
			name: a.name,
			agent: a.agent,
			modelRef,
			stats,
			activity: a.activity ?? a.taskPreview ?? "starting…",
			detailSections: sections,
			canKill: true,
			canResume: false,
			sessionFile: a.sessionFile,
			onKill: async () => {
				await stopRunningSubagent(a);
				ctx.ui.notify(`Stopped ${a.name}`, "info");
			},
		});
	}
	return items;
}

export async function buildCompletedItems(ctx: OverlayContext): Promise<OverlayItem[]> {
	const items: OverlayItem[] = [];
	const seen = new Set<string>();
	const latestCompleted = new Map<string, CompletedSubagentResult>();
	const runningSessionFiles = new Set(
		[...runningSubagents.values()].map((subagent) => subagent.sessionFile).filter(Boolean),
	);

	for (const [id, r] of completedSubagentResults) {
		latestCompleted.set(r.sessionFile ?? id, r);
	}

	for (const [dedupeKey, r] of latestCompleted) {
		seen.add(dedupeKey);

		const visual = statusVisuals(r.status);

		const summary = r.errorMessage
			? `error: ${firstLine(r.errorMessage, 40)}`
			: r.summary
				? firstLine(r.summary, 40)
				: `exit ${r.exitCode}`;

		const sessionStats = readCompletedSessionStats(r.sessionFile);
		const meta = r.sessionFile ? safeMeta(r.sessionFile) : undefined;
		const defs = r.agent ? safeDefs(r.agent, ctx.cwd) : null;
		const sections = buildSections(defs, meta);
		sections.push(
			completedRuntimeSection({
				status: r.status,
				elapsed: r.elapsed,
				exitCode: r.exitCode,
				outputTokens: r.outputTokens,
				sessionFile: r.sessionFile,
				stats: sessionStats,
			}),
		);

		items.push({
			id: r.id,
			icon: visual.icon,
			iconColor: visual.color,
			name: r.name,
			agent: r.agent,
			modelRef: meta?.modelRef,
			status: r.status === "completed" ? undefined : visual.label,
			statusColor: r.status === "completed" ? undefined : visual.color,
			stats: [formatElapsedSeconds(r.elapsed), ...compactStats(sessionStats, r.outputTokens)],
			activity: summary,
			detailSections: sections,
			canKill: false,
			canResume: true,
			sessionFile: r.sessionFile,
		});
	}

	const sf = ctx.sessionManager.getSessionFile?.();
	if (sf) {
		try {
			const entries = getEntries(sf) as Array<{ [key: string]: unknown }>;
			for (const entry of entries) {
				const recovered = recoverResultDetails(entry);
				if (
					!recovered?.sessionFile ||
					seen.has(recovered.sessionFile) ||
					runningSessionFiles.has(recovered.sessionFile)
				)
					continue;
				seen.add(recovered.sessionFile);
				const visual = statusVisuals(recovered.status);
				const summary = recovered.errorMessage
					? `error: ${firstLine(recovered.errorMessage, 80)}`
					: recoverSummary(entry);
				const sessionStats = readCompletedSessionStats(recovered.sessionFile);
				const meta = safeMeta(recovered.sessionFile);
				const defs = recovered.agent ? safeDefs(recovered.agent, ctx.cwd) : null;
				const sections = buildSections(defs, meta);
				sections.push(
					completedRuntimeSection({
						status: recovered.status,
						elapsed: recovered.elapsed,
						exitCode: recovered.exitCode,
						sessionFile: recovered.sessionFile,
						stats: sessionStats,
					}),
				);

				items.push({
					id: recovered.id,
					icon: visual.icon,
					iconColor: visual.color,
					name: recovered.name,
					agent: recovered.agent,
					modelRef: meta?.modelRef,
					status: recovered.status === "completed" ? undefined : visual.label,
					statusColor: recovered.status === "completed" ? undefined : visual.color,
					stats: [
						...(recovered.elapsed != null ? [formatElapsedSeconds(recovered.elapsed)] : []),
						...compactStats(sessionStats),
					],
					activity: summary,
					detailSections: sections,
					canKill: false,
					canResume: true,
					sessionFile: recovered.sessionFile,
				});
			}
		} catch {
			/* ignore */
		}
	}

	return items;
}

export function buildAgentItems(_ctx: OverlayContext): OverlayItem[] {
	return getEffectiveAgentDefinitions().map((d) => {
		const defs = d as AgentDetailDefaults;
		const sections = buildSections(defs, undefined);
		if (d.body) {
			const bodyLines = d.body
				.split("\n")
				.filter((l: string) => l.trim())
				.map((l: string) => ({ label: "", value: l }));
			sections.push({ title: "Agent Body", fields: bodyLines });
		}

		return {
			id: d.name,
			icon: "◆",
			iconColor: "accent",
			name: d.name,
			agent: undefined,
			stats: [],
			activity: d.description ? firstLine(d.description, 60) : "(no description)",
			detailSections: sections,
			canKill: false,
			canResume: false,
		};
	});
}
