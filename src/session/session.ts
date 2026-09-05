import { randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CALLER_PING_TOOL_NAME, SUBAGENT_DONE_TOOL_NAME } from "../tools/tool-names.ts";
import type { SubagentSummarySource } from "../types.ts";

/** Session entry recording how a child's run ended. */
export const SUBAGENT_COMPLETION_ENTRY = "pi-subagent-completion";

/** The child stopped because its context-warning policy told it to. */
export const SUBAGENT_CONTEXT_PRESSURE_REASON = "context-pressure";

/** The child failed while it was already holding the final warning. */
export const SUBAGENT_CONTEXT_PRESSURE_FAILURE_REASON = "context-pressure-failure";

export interface SessionEntry {
	type: string;
	id: string;
	parentId?: string;
	[key: string]: unknown;
}

interface MessageEntry extends SessionEntry {
	type: "message";
	message: {
		role: "user" | "assistant" | "toolResult";
		toolName?: string;
		content: Array<{ type: string; text?: string; [key: string]: unknown }>;
	};
}

function getNonEmptyLines(sessionFile: string): string[] {
	return readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter((line) => line.trim());
}

function parseEntryLine(sessionFile: string, line: string, lineNumber: number): SessionEntry {
	try {
		return JSON.parse(line) as SessionEntry;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid session JSONL at ${sessionFile}:${lineNumber}: ${message}`);
	}
}

export function getEntries(sessionFile: string): SessionEntry[] {
	return getNonEmptyLines(sessionFile).map((line, index) =>
		parseEntryLine(sessionFile, line, index + 1),
	);
}

export function getLeafId(sessionFile: string): string | null {
	const entries = getEntries(sessionFile);
	return entries.length > 0 ? entries[entries.length - 1].id : null;
}

export function getEntryCount(sessionFile: string): number {
	return getNonEmptyLines(sessionFile).length;
}

export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
	return getNonEmptyLines(sessionFile)
		.slice(afterLine)
		.map((line, index) => parseEntryLine(sessionFile, line, afterLine + index + 1));
}

/**
 * Sum output usage from messages and summaries, not copied retained context.
 * Supply getNewEntries(sessionFile, launchEntryCount) to count only one run.
 */
export function sumSessionOutputTokens(entries: SessionEntry[]): number {
	let total = 0;
	for (const entry of entries) {
		let usage: { output?: number } | undefined;
		if (entry.type === "message") {
			const message = entry.message as { role?: string; usage?: { output?: number } };
			if (message?.role === "assistant" || message?.role === "toolResult") usage = message.usage;
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			usage = entry.usage as { output?: number } | undefined;
		}
		const output = usage?.output;
		if (typeof output === "number" && Number.isSafeInteger(output) && output >= 0) total += output;
	}
	return total;
}

export interface SessionCallerPing {
	toolCallId: string;
	message: string;
}

/**
 * Read call arguments only. The tool may end the child before its result is saved.
 * The caller supplies the run's entries and the child's name separately.
 */
export function findCallerPings(entries: SessionEntry[]): SessionCallerPing[] {
	const pings: SessionCallerPing[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown[] } | undefined;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			const call = block as {
				type?: string;
				id?: string;
				name?: string;
				arguments?: { message?: string };
			};
			if (
				call?.type === "toolCall" &&
				call.name === CALLER_PING_TOOL_NAME &&
				typeof call.id === "string" &&
				typeof call.arguments?.message === "string"
			) {
				pings.push({ toolCallId: call.id, message: call.arguments.message });
			}
		}
	}
	return pings;
}

export interface SessionError {
	stopReason: "error";
	errorMessage: string;
}

/**
 * Read the last assistant's error, not an earlier failure that a retry resolved.
 * Supply only the run's entries to avoid reading an earlier run's error.
 */
export function findSubagentError(entries: SessionEntry[]): SessionError | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message") continue;
		const message = entry.message as
			| { role?: string; stopReason?: string; errorMessage?: string }
			| undefined;
		if (message?.role !== "assistant") continue;
		if (message.stopReason !== "error") return undefined;
		return {
			stopReason: "error",
			errorMessage:
				typeof message.errorMessage === "string" && message.errorMessage.trim() !== ""
					? message.errorMessage
					: "Subagent error",
		};
	}
	return undefined;
}

function getTextContent(msg: MessageEntry): string | null {
	const texts = msg.message.content
		.filter(
			(block) =>
				block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
		)
		.map((block) => block.text as string);

	return texts.length > 0 && texts.join("").trim() ? texts.join("\n") : null;
}

function getStopReason(msg: MessageEntry): string | null {
	const stopReason = (msg.message as Record<string, unknown>).stopReason;
	return typeof stopReason === "string" && stopReason.trim() !== "" ? stopReason : null;
}

function isToolUseStopReason(stopReason: string | null): boolean {
	return stopReason?.replace(/[-_]/g, "").toLowerCase() === "tooluse";
}

function getTerminalStopMessage(msg: MessageEntry): string | null {
	const stopReason = getStopReason(msg);
	if (!stopReason) return null;

	const errorMessage = (msg.message as Record<string, unknown>).errorMessage;
	if (stopReason === "error") {
		return typeof errorMessage === "string" && errorMessage.trim() !== ""
			? `Subagent error: ${errorMessage.trim()}`
			: "Subagent error";
	}

	return getSubagentTerminalStopMessage(stopReason);
}

function getSubagentTerminalStopMessage(stopReason: string): string {
	return `Subagent stopped before producing a result (stopReason: ${stopReason})`;
}

export function getSubagentTerminalStopReason(summary: string): string | null {
	const match = /^Subagent stopped before producing a result \(stopReason: (.+)\)$/.exec(summary);
	return match?.[1]?.trim() || null;
}

export interface SubagentOutput {
	summary: string;
	summarySource: SubagentSummarySource;
}

export interface AssistantContextSnapshot {
	contextTokens: number;
	provider?: string;
	model?: string;
}

export function findLatestAssistantContextSnapshot(
	entries: SessionEntry[],
): AssistantContextSnapshot | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message") continue;
		const message = (entry as { message?: Record<string, unknown> }).message;
		if (message?.role !== "assistant") continue;
		const usage = message.usage as
			| {
					totalTokens?: number;
					input?: number;
					output?: number;
					cacheRead?: number;
					cacheWrite?: number;
			  }
			| undefined;
		if (!usage) continue;
		return {
			contextTokens:
				usage.totalTokens ??
				(usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
			provider: typeof message.provider === "string" ? message.provider : undefined,
			model: typeof message.model === "string" ? message.model : undefined,
		};
	}
	return undefined;
}

export function findLatestAssistantContextTokens(entries: SessionEntry[]): number | undefined {
	return findLatestAssistantContextSnapshot(entries)?.contextTokens;
}

function findLastAssistantOutput(entries: SessionEntry[]): SubagentOutput | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const msg = entry as MessageEntry;
		if (msg.message.role !== "assistant") continue;
		const text = getTextContent(msg);
		if (text) return { summary: text, summarySource: "subagent" };
		// A tool-use assistant message is a boundary, not a final answer. Stop
		// before stale assistant text and let the caller inspect the trailing tool
		// result, which may be the intentional output of a terminating tool.
		if (isToolUseStopReason(getStopReason(msg))) return null;

		// A terminal assistant turn with no text is still the child outcome.
		// Mark the synthesized status as runtime-owned instead of presenting it as
		// the child's work.
		const stopMessage = getTerminalStopMessage(msg);
		if (stopMessage) return { summary: stopMessage, summarySource: "runtime" };
	}
	return null;
}

export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
	return findLastAssistantOutput(entries)?.summary ?? null;
}

export function findLastSubagentOutputWithSource(entries: SessionEntry[]): SubagentOutput | null {
	const assistantOutput = findLastAssistantOutput(entries);
	if (assistantOutput) return assistantOutput;

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const msg = entry as MessageEntry;
		if (msg.message.role !== "toolResult") continue;
		if (msg.message.toolName === SUBAGENT_DONE_TOOL_NAME) continue;
		if (msg.message.toolName === CALLER_PING_TOOL_NAME) continue;
		const text = getTextContent(msg);
		if (text) return { summary: text, summarySource: "subagent" };
	}
	return null;
}

export function findLastSubagentOutput(entries: SessionEntry[]): string | null {
	return findLastSubagentOutputWithSource(entries)?.summary ?? null;
}

export function appendBranchSummary(
	sessionFile: string,
	branchPointId: string,
	fromId: string | null,
	summary: string,
): string {
	const id = randomBytes(4).toString("hex");
	const entry = {
		type: "branch_summary",
		id,
		parentId: branchPointId,
		timestamp: new Date().toISOString(),
		fromId: fromId ?? branchPointId,
		summary,
	};
	appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
	return id;
}

export function copySessionFile(sessionFile: string, destDir: string): string {
	const id = randomBytes(4).toString("hex");
	const dest = join(destDir, `subagent-${id}.jsonl`);
	copyFileSync(sessionFile, dest);
	return dest;
}

export function mergeNewEntries(
	sourceFile: string,
	targetFile: string,
	afterLine: number,
): SessionEntry[] {
	const entries = getNewEntries(sourceFile, afterLine);
	for (const entry of entries) {
		appendFileSync(targetFile, `${JSON.stringify(entry)}\n`, "utf8");
	}
	return entries;
}

/**
 * True when the child's last completed run ended because its context-warning
 * policy told it to stop. Only a terminal wrap-up sets this, so a child that
 * merely saw an early warning and then finished normally is not reported.
 *
 * The last marker wins: a later clean completion releases a session that an
 * earlier context-pressure exit had blocked.
 */
export function endedUnderContextPressure(sessionFile: string): boolean {
	if (!existsSync(sessionFile)) return false;
	try {
		const entries = getEntries(sessionFile) as Array<{
			id?: string;
			parentId?: string;
			type?: unknown;
			customType?: unknown;
			data?: { reason?: unknown };
		}>;
		if (entries.length === 0) return false;
		// Walk back from the active leaf. A marker on an abandoned branch
		// describes a run this session no longer descends from.
		const byId = new Map(
			entries.filter((entry) => entry.id).map((entry) => [entry.id as string, entry]),
		);
		let current: (typeof entries)[number] | undefined = entries[entries.length - 1];
		const seen = new Set<string>();
		while (current) {
			if (current.type === "custom" && current.customType === SUBAGENT_COMPLETION_ENTRY) {
				return current.data?.reason === SUBAGENT_CONTEXT_PRESSURE_REASON;
			}
			if (current.id) {
				if (seen.has(current.id)) break;
				seen.add(current.id);
			}
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		return false;
	} catch {
		return false;
	}
}
