import type { BeforeAgentStartEvent, Skill } from "@earendil-works/pi-coding-agent";
import { PI_SUBAGENT_APPEND_SYSTEM_PROMPT } from "../launch/append-system.ts";
import { applySkillVisibilityToSystemPrompt, PI_SUBAGENT_SKILL_VISIBILITY } from "../launch/skill-visibility.ts";

/**
 * Child-side system-prompt composition for the mandatory child extension:
 * apply skill visibility annotations first, then any inherited append-system
 * text. Returns undefined when neither changes the prompt.
 */
export function applyChildSystemPromptOverrides(
	event: Pick<BeforeAgentStartEvent, "systemPrompt" | "systemPromptOptions">,
): { systemPrompt: string } | undefined {
	let systemPrompt = event.systemPrompt;
	const selectedTools = event.systemPromptOptions?.selectedTools;
	const readAvailable = !selectedTools || selectedTools.includes("read");
	const visibilitySpec = process.env[PI_SUBAGENT_SKILL_VISIBILITY]?.trim();
	if (visibilitySpec) {
		systemPrompt = applySkillVisibilityToSystemPrompt(
			systemPrompt,
			(event.systemPromptOptions?.skills ?? []) as Skill[],
			visibilitySpec,
			readAvailable,
		);
	}
	const appendSystemPrompt = process.env[PI_SUBAGENT_APPEND_SYSTEM_PROMPT]?.trim();
	if (!appendSystemPrompt && systemPrompt === event.systemPrompt) return undefined;
	if (!appendSystemPrompt) return { systemPrompt };
	return { systemPrompt: `${systemPrompt}\n\n${appendSystemPrompt}` };
}
