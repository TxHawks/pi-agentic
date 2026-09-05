import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

// These checks guard fields consumed from JSON. Pi owns the types; this is
// not a second event schema. Extra provider and extension fields stay intact
// in the human live view, but must never be copied into peek.
export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function hasUsage(value: unknown): boolean {
	if (!isObject(value) || !isObject(value.cost)) return false;
	return (
		[
			value.input,
			value.output,
			value.cacheRead,
			value.cacheWrite,
			value.totalTokens,
			value.cost.input,
			value.cost.output,
			value.cost.cacheRead,
			value.cost.cacheWrite,
			value.cost.total,
		].every(isCount) &&
		(value.reasoning === undefined || isCount(value.reasoning)) &&
		(value.cacheWrite1h === undefined || isCount(value.cacheWrite1h))
	);
}

const STOP_REASONS = new Set([
	"pending",
	"stop",
	"length",
	"toolUse",
	"error",
	"aborted",
	"deferred",
]);

export function hasMessage(value: unknown): boolean {
	if (!isObject(value) || !isCount(value.timestamp)) return false;
	switch (value.role) {
		case "assistant":
			return (
				Array.isArray(value.content) &&
				value.content.every(hasContent) &&
				hasUsage(value.usage) &&
				STOP_REASONS.has(value.stopReason as string) &&
				typeof value.api === "string" &&
				typeof value.provider === "string" &&
				typeof value.model === "string" &&
				(value.errorMessage === undefined || typeof value.errorMessage === "string")
			);
		case "user":
		case "custom":
			return (
				typeof value.content === "string" ||
				(Array.isArray(value.content) && value.content.every(hasContent))
			);
		case "toolResult":
			return (
				typeof value.toolCallId === "string" &&
				typeof value.toolName === "string" &&
				Array.isArray(value.content) &&
				value.content.every(hasContent) &&
				typeof value.isError === "boolean" &&
				(value.usage === undefined || hasUsage(value.usage))
			);
		case "bashExecution":
			return typeof value.command === "string" && typeof value.output === "string";
		case "branchSummary":
		case "compactionSummary":
			return typeof value.summary === "string";
		default:
			return false;
	}
}

function hasContent(value: unknown): boolean {
	if (!isObject(value)) return false;
	switch (value.type) {
		case "text":
			return typeof value.text === "string";
		case "thinking":
			return typeof value.thinking === "string";
		case "image":
			return typeof value.data === "string" && typeof value.mimeType === "string";
		case "toolCall":
			return (
				typeof value.id === "string" && typeof value.name === "string" && isObject(value.arguments)
			);
		default:
			return false;
	}
}

type MessageUpdate = Extract<JsonAgentSessionEvent, { type: "message_update" }>;

/** Check the delta-only JSON form, not the SDK's cumulative partial message. */
export function checkMessageUpdate(event: MessageUpdate): boolean | "unknown" {
	if (!hasUsage(event.usage) || !isObject(event.assistantMessageEvent)) return false;
	const update = event.assistantMessageEvent;
	switch (update.type) {
		case "start":
			return true;
		case "text_start":
		case "thinking_start":
			return Number.isInteger(update.contentIndex) && update.contentIndex >= 0;
		case "toolcall_start":
			return (
				Number.isInteger(update.contentIndex) &&
				update.contentIndex >= 0 &&
				typeof update.id === "string" &&
				typeof update.toolName === "string"
			);
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return (
				Number.isInteger(update.contentIndex) &&
				update.contentIndex >= 0 &&
				typeof update.delta === "string"
			);
		case "text_end":
		case "thinking_end":
			return (
				Number.isInteger(update.contentIndex) &&
				update.contentIndex >= 0 &&
				typeof update.content === "string"
			);
		case "toolcall_end":
			return (
				Number.isInteger(update.contentIndex) &&
				update.contentIndex >= 0 &&
				hasContent(update.toolCall)
			);
		case "done":
			return (
				hasMessage(update.message) &&
				["stop", "length", "toolUse", "deferred"].includes(update.reason)
			);
		case "error":
			return hasMessage(update.error) && ["aborted", "error"].includes(update.reason);
		default: {
			const unhandled: never = update;
			void unhandled;
			return "unknown";
		}
	}
}
