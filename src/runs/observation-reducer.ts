import type { StopReason, Usage } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	checkMessageUpdate,
	hasMessage,
	hasUsage,
	isCount,
	isObject,
} from "./observation-content.ts";

export interface ObservedCallerPing {
	toolCallId: string;
	message: string;
}

/** State from the part of the observation log this reader has seen. */
export class ObservationReducer {
	private eventCount = 0;
	private turnCount = 0;
	private messageCount = 0;
	private toolsStarted = 0;
	private toolsCompleted = 0;
	private toolsFailed = 0;
	private toolNames = new Set<string>();
	private activeTools = new Map<string, { name: string; startedAtMs: number }>();
	private usage = emptyUsage();
	private latestAssistantUsage: Usage | null = null;
	private streamingUsage: Usage | null = null;
	private assistantErrors = 0;
	private agentSettled = false;
	private agentEndWillRetry: boolean | null = null;
	private lastStopReason: StopReason | null = null;
	private lastEventAtMs: number | null = null;
	private retry = {
		active: false,
		starts: 0,
		attempt: 0,
		maxAttempts: 0,
		delayMs: 0,
		success: null as boolean | null,
	};
	private summarizationRetry = { active: false, starts: 0, attempt: 0, maxAttempts: 0, delayMs: 0 };
	private queue = { steering: 0, followUp: 0 };
	private compaction = {
		active: false,
		starts: 0,
		reason: null as Extract<JsonAgentSessionEvent, { type: "compaction_start" }>["reason"] | null,
		aborted: null as boolean | null,
		willRetry: null as boolean | null,
		errors: 0,
	};

	apply(event: JsonAgentSessionEvent, atMs: number) {
		const result = this.reduce(event, atMs);
		if (result !== "malformed" && result !== "unknown") {
			this.eventCount += 1;
			this.lastEventAtMs = atMs;
		}
		return result;
	}

	private reduce(
		event: JsonAgentSessionEvent,
		atMs: number,
	): ObservedCallerPing | null | "malformed" | "unknown" {
		switch (event.type) {
			case "turn_start":
				this.turnCount += 1;
				return null;
			case "message_end":
				if (!hasMessage(event.message)) return "malformed";
				this.messageCount += 1;
				if (event.message.role === "assistant" || event.message.role === "toolResult") {
					if (event.message.usage) addUsage(this.usage, event.message.usage);
					if (event.message.role === "assistant") {
						this.latestAssistantUsage = copyUsage(event.message.usage);
						this.streamingUsage = null;
						this.lastStopReason = event.message.stopReason;
						if (event.message.stopReason === "error") this.assistantErrors += 1;
					}
				}
				return null;
			case "tool_execution_start":
				if (
					typeof event.toolCallId !== "string" ||
					typeof event.toolName !== "string" ||
					!("args" in event)
				)
					return "malformed";
				this.toolsStarted += 1;
				this.toolNames.add(event.toolName);
				this.activeTools.set(event.toolCallId, { name: event.toolName, startedAtMs: atMs });
				if (event.toolName === "caller_ping" && typeof event.args?.message === "string") {
					return { toolCallId: event.toolCallId, message: event.args.message };
				}
				return null;
			case "tool_execution_end":
				if (
					typeof event.toolCallId !== "string" ||
					typeof event.toolName !== "string" ||
					typeof event.isError !== "boolean" ||
					!("result" in event)
				)
					return "malformed";
				this.toolsCompleted += 1;
				if (event.isError) this.toolsFailed += 1;
				this.toolNames.add(event.toolName);
				this.activeTools.delete(event.toolCallId);
				return null;
			case "agent_start":
				this.agentSettled = false;
				this.agentEndWillRetry = null;
				return null;
			case "agent_end":
				if (
					!Array.isArray(event.messages) ||
					!event.messages.every(hasMessage) ||
					typeof event.willRetry !== "boolean"
				)
					return "malformed";
				this.agentEndWillRetry = event.willRetry;
				return null;
			case "agent_settled":
				this.agentSettled = true;
				return null;
			case "auto_retry_start":
				if (
					![event.attempt, event.maxAttempts, event.delayMs].every(isCount) ||
					typeof event.errorMessage !== "string"
				)
					return "malformed";
				this.retry = {
					active: true,
					starts: this.retry.starts + 1,
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					success: null,
				};
				return null;
			case "auto_retry_end":
				if (
					!isCount(event.attempt) ||
					typeof event.success !== "boolean" ||
					(event.finalError !== undefined && typeof event.finalError !== "string")
				)
					return "malformed";
				this.retry = {
					...this.retry,
					active: false,
					attempt: event.attempt,
					success: event.success,
				};
				return null;
			case "turn_end":
				return hasMessage(event.message) &&
					Array.isArray(event.toolResults) &&
					event.toolResults.every(hasMessage)
					? null
					: "malformed";
			case "message_start":
				if (!hasMessage(event.message)) return "malformed";
				if (event.message.role === "assistant")
					this.streamingUsage = copyUsage(event.message.usage);
				return null;
			case "message_update": {
				const valid = checkMessageUpdate(event);
				if (valid === "unknown") return "unknown";
				if (!valid) return "malformed";
				this.streamingUsage = copyUsage(event.usage);
				return null;
			}
			case "tool_execution_update":
				return typeof event.toolCallId === "string" &&
					typeof event.toolName === "string" &&
					"args" in event &&
					"partialResult" in event
					? null
					: "malformed";
			case "queue_update":
				if (
					!Array.isArray(event.steering) ||
					!event.steering.every((text) => typeof text === "string") ||
					!Array.isArray(event.followUp) ||
					!event.followUp.every((text) => typeof text === "string")
				)
					return "malformed";
				this.queue = { steering: event.steering.length, followUp: event.followUp.length };
				return null;
			case "compaction_start":
				if (!["manual", "threshold", "overflow"].includes(event.reason)) return "malformed";
				this.compaction = {
					...this.compaction,
					active: true,
					starts: this.compaction.starts + 1,
					reason: event.reason,
					aborted: null,
					willRetry: null,
				};
				return null;
			case "compaction_end":
				if (
					!["manual", "threshold", "overflow"].includes(event.reason) ||
					typeof event.aborted !== "boolean" ||
					typeof event.willRetry !== "boolean" ||
					(event.result !== undefined && !isObject(event.result)) ||
					(event.errorMessage !== undefined && typeof event.errorMessage !== "string")
				)
					return "malformed";
				this.compaction = {
					...this.compaction,
					active: false,
					reason: event.reason,
					aborted: event.aborted,
					willRetry: event.willRetry,
					errors: this.compaction.errors + (event.errorMessage ? 1 : 0),
				};
				return null;
			case "entry_appended":
				if (!isObject(event.entry) || typeof event.entry.type !== "string") return "malformed";
				// The entry is the sole source of summary usage. Message entries
				// repeat message_end; compaction_end repeats the summary result.
				if (
					(event.entry.type === "compaction" || event.entry.type === "branch_summary") &&
					event.entry.usage !== undefined
				) {
					if (!hasUsage(event.entry.usage)) return "malformed";
					addUsage(this.usage, event.entry.usage);
				}
				return null;
			case "session_info_changed":
				return event.name === undefined || typeof event.name === "string" ? null : "malformed";
			case "thinking_level_changed":
				return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(event.level)
					? null
					: "malformed";
			case "summarization_retry_scheduled":
				if (
					![event.attempt, event.maxAttempts, event.delayMs].every(isCount) ||
					typeof event.errorMessage !== "string"
				)
					return "malformed";
				this.summarizationRetry = {
					active: true,
					starts: this.summarizationRetry.starts + 1,
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
				};
				return null;
			case "summarization_retry_attempt_start":
				return event.source === "branchSummary" ||
					(event.source === "compaction" &&
						["manual", "threshold", "overflow"].includes(event.reason))
					? null
					: "malformed";
			case "summarization_retry_finished":
				this.summarizationRetry.active = false;
				return null;
			case "bash_execution_update":
				return typeof event.delta === "string" ? null : "malformed";
			default: {
				// A new Pi event must fail type checking, not silently disappear.
				const unhandled: never = event;
				void unhandled;
				return "unknown";
			}
		}
	}

	peek(nowMs: number) {
		return {
			eventCount: this.eventCount,
			turnCount: this.turnCount,
			messageCount: this.messageCount,
			assistantErrors: this.assistantErrors,
			retry: { ...this.retry },
			summarizationRetry: { ...this.summarizationRetry },
			queue: { ...this.queue },
			compaction: { ...this.compaction },
			lastEventAgeMs: this.lastEventAtMs === null ? null : Math.max(0, nowMs - this.lastEventAtMs),
			tools: {
				started: this.toolsStarted,
				completed: this.toolsCompleted,
				failed: this.toolsFailed,
				names: [...this.toolNames],
				active: [...this.activeTools.values()].map((tool) => ({
					name: tool.name,
					elapsedMs: Math.max(0, nowMs - tool.startedAtMs),
				})),
			},
			usage: structuredClone(this.usage),
			latestAssistantUsage: this.latestAssistantUsage ? copyUsage(this.latestAssistantUsage) : null,
			streamingUsage: this.streamingUsage ? copyUsage(this.streamingUsage) : null,
		};
	}
	detectors(nowMs: number, callerPings: ObservedCallerPing[]) {
		return {
			settle: {
				agentSettled: this.agentSettled,
				agentEndWillRetry: this.agentEndWillRetry,
				lastStopReason: this.lastStopReason,
			},
			retry: { ...this.retry },
			callerPings,
			lastEventAgeMs: this.lastEventAtMs === null ? null : Math.max(0, nowMs - this.lastEventAtMs),
		};
	}
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function copyUsage(usage: Usage): Usage {
	const result = emptyUsage();
	addUsage(result, usage);
	return result;
}

function addUsage(total: Usage, usage: Usage): void {
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
		total[key] += usage[key];
	for (const key of ["cacheWrite1h", "reasoning"] as const) {
		if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key];
	}
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
		total.cost[key] += usage.cost[key];
}
