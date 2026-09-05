import { getEntries } from "../../session/session.ts";
import { getSubagentActivityStartIndex } from "../../session/session-files.ts";
import type { SessionContentBlock, SessionMessageLike, SessionUsage } from "../../types.ts";
import { compactCount, firstLine } from "./render-helpers.ts";
import type { DetailSection } from "./render-types.ts";

/**
 * Completed-run reconstruction for the overlay: read a finished child session
 * file for its stats, recover result details recorded in the parent session,
 * and build the execution detail section from them.
 */

interface CompletedSessionStats {
	messages: number;
	toolUses: number;
	/** Snapshot of the final assistant message's usage total — the context footprint, not a cumulative sum. */
	contextTokens: number;
	inputTokens: number;
	outputTokens: number;
	model?: string;
	provider?: string;
}

function usageTotal(usage: SessionUsage): number {
	return (
		usage.totalTokens ??
		(usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
	);
}

function getSessionMessage(entry: { [key: string]: unknown }): SessionMessageLike | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	return typeof message === "object" && message !== null
		? (message as SessionMessageLike)
		: undefined;
}

export function readCompletedSessionStats(sessionFile?: string): CompletedSessionStats | undefined {
	if (!sessionFile) return undefined;
	try {
		let messages = 0;
		let toolUses = 0;
		let contextTokens = 0;
		let inputTokens = 0;
		let outputTokens = 0;
		let model: string | undefined;
		let provider: string | undefined;

		const entries = getEntries(sessionFile) as Array<{
			[key: string]: unknown;
		}>;
		// Skip inherited parent history in forked child sessions; count only
		// entries after this subagent's launch marker.
		const startIndex = getSubagentActivityStartIndex(entries);
		for (let i = startIndex; i < entries.length; i++) {
			const message = getSessionMessage(entries[i]);
			if (!message) continue;
			if (message.role === "toolResult") {
				toolUses++;
				continue;
			}
			messages++;
			if (message.role !== "assistant") continue;
			if (message.model) model = message.model;
			if (message.provider) provider = message.provider;
			if (message.usage) {
				// Snapshot, not sum: the latest assistant turn reflects the context
				// footprint. Cumulative input/output are tracked separately below.
				contextTokens = usageTotal(message.usage);
				inputTokens += message.usage.input ?? 0;
				outputTokens += message.usage.output ?? 0;
			}
			if (Array.isArray(message.content)) {
				toolUses += message.content.filter(
					(block: SessionContentBlock) => block.type === "toolCall" || block.type === "toolUse",
				).length;
			}
		}

		return {
			messages,
			toolUses,
			contextTokens,
			inputTokens,
			outputTokens,
			model,
			provider,
		};
	} catch {
		return undefined;
	}
}

export function compactStats(
	stats?: CompletedSessionStats,
	fallbackOutputTokens?: number,
): string[] {
	if (!stats) return fallbackOutputTokens ? [`${compactCount(fallbackOutputTokens)} output`] : [];
	const result: string[] = [];
	if (stats.messages > 0) result.push(`${stats.messages} msg`);
	if (stats.toolUses > 0) result.push(`${stats.toolUses} tool${stats.toolUses === 1 ? "" : "s"}`);
	if (stats.contextTokens > 0) result.push(`${compactCount(stats.contextTokens)} ctx`);
	else if (fallbackOutputTokens) result.push(`${compactCount(fallbackOutputTokens)} output`);
	return result;
}

export function completedRuntimeSection(args: {
	status: "completed" | "cancelled" | "failed";
	elapsed?: number;
	exitCode?: number;
	outputTokens?: number;
	sessionFile?: string;
	stats?: CompletedSessionStats;
}): DetailSection {
	const fields: Array<{ label: string; value: string }> = [];
	fields.push({ label: "status", value: args.status });
	if (args.elapsed != null) fields.push({ label: "elapsed", value: `${args.elapsed}s` });
	if (args.exitCode != null) fields.push({ label: "exit", value: `${args.exitCode}` });
	if (args.stats?.messages) fields.push({ label: "messages", value: `${args.stats.messages}` });
	if (args.stats?.toolUses) fields.push({ label: "tool calls", value: `${args.stats.toolUses}` });
	if (args.stats?.contextTokens)
		fields.push({
			label: "context tokens",
			value: compactCount(args.stats.contextTokens),
		});
	if (args.stats?.inputTokens)
		fields.push({
			label: "input tokens",
			value: compactCount(args.stats.inputTokens),
		});
	if (args.stats?.outputTokens)
		fields.push({
			label: "output tokens",
			value: compactCount(args.stats.outputTokens),
		});
	else if (args.outputTokens)
		fields.push({
			label: "output tokens",
			value: compactCount(args.outputTokens),
		});
	if (args.sessionFile) fields.push({ label: "session", value: args.sessionFile });
	return { title: "Execution", fields };
}

interface RecoveredResultDetails {
	id: string;
	name: string;
	agent?: string;
	status: "completed" | "cancelled" | "failed";
	exitCode?: number;
	elapsed?: number;
	sessionFile?: string;
	errorMessage?: string;
}

function getEntryDetails(entry: { [key: string]: unknown }): Record<string, unknown> | undefined {
	const direct = entry.details;
	if (typeof direct === "object" && direct !== null) return direct as Record<string, unknown>;
	const message = entry.message;
	if (typeof message !== "object" || message === null) return undefined;
	const details = (message as { details?: unknown }).details;
	return typeof details === "object" && details !== null
		? (details as Record<string, unknown>)
		: undefined;
}

export function recoverResultDetails(entry: {
	[key: string]: unknown;
}): RecoveredResultDetails | undefined {
	if (entry.type !== "custom_message" || entry.customType !== "subagent_result") return undefined;
	const details = getEntryDetails(entry);
	if (!details) return undefined;
	const name = typeof details.name === "string" ? details.name : undefined;
	const id = typeof details.id === "string" ? details.id : name;
	const rawStatus = typeof details.status === "string" ? details.status : undefined;
	const status =
		rawStatus === "completed" || rawStatus === "cancelled" || rawStatus === "failed"
			? rawStatus
			: details.exitCode === 0
				? "completed"
				: "failed";
	if (!id || !name) return undefined;
	return {
		id,
		name,
		agent: typeof details.agent === "string" ? details.agent : undefined,
		status,
		exitCode: typeof details.exitCode === "number" ? details.exitCode : undefined,
		elapsed: typeof details.elapsed === "number" ? details.elapsed : undefined,
		sessionFile: typeof details.sessionFile === "string" ? details.sessionFile : undefined,
		errorMessage: typeof details.errorMessage === "string" ? details.errorMessage : undefined,
	};
}

export function recoverSummary(entry: { [key: string]: unknown }): string {
	const content = typeof entry.content === "string" ? entry.content : "";
	const [, afterHeader = content] = content.split(/\n\n/, 2);
	return firstLine(afterHeader.replace(/\n\nSession:[\s\S]*$/, ""), 90) || "completed";
}

export function statusVisuals(status: "completed" | "cancelled" | "failed") {
	if (status === "completed") return { icon: "✓", color: "success", label: "completed" };
	if (status === "cancelled") return { icon: "⚡", color: "warning", label: "cancelled" };
	return { icon: "✕", color: "error", label: "failed" };
}
