import { assertModelAllowed, buildModelRef, splitModelRef } from "../agents/model-refs.ts";
import { parseEnvString } from "../launch/env.ts";
import { normalizeModelRef, resolveAvailableModelRef } from "../launch/prep.ts";
import { resolveHerdrPlacementPolicy, resolveZellijPlacementPolicy } from "../mux.ts";
import type { PersistedSubagentLaunchMetadata } from "../session/session-files.ts";

/**
 * Resolution of one resume invocation: how the persisted launch metadata,
 * the requested model and thinking overrides, and the placement policies
 * combine into the metadata the new run launches with.
 */

export interface ResumeModelRegistry {
	getAvailable(): Array<{
		provider: string;
		id: string;
		reasoning?: boolean;
		thinkingLevelMap?: Record<string, string | null | undefined>;
	}>;
}

function splitResumeModelRef(
	model: string,
	fallbackThinking: string | undefined,
): { model: string; thinking: string | undefined; explicitThinking: boolean } {
	const split = splitModelRef(model);
	return split.thinking === undefined
		? { model, thinking: fallbackThinking, explicitThinking: false }
		: { model: split.model, thinking: split.thinking, explicitThinking: true };
}

export function resolveResumeHerdrPlacementPolicy(
	launchMetadata: PersistedSubagentLaunchMetadata | undefined,
	parentPolicy: string | undefined,
): ReturnType<typeof resolveHerdrPlacementPolicy> | undefined {
	const agentPolicy = parseEnvString(launchMetadata?.env).PI_SUBAGENT_HERDR_PLACEMENT;
	if (agentPolicy !== undefined) return resolveHerdrPlacementPolicy(agentPolicy);
	if (parentPolicy !== undefined) return resolveHerdrPlacementPolicy(parentPolicy);
	return launchMetadata?.herdrPlacementPolicy;
}

export function resolveResumeZellijPlacementPolicy(
	launchMetadata: PersistedSubagentLaunchMetadata | undefined,
	parentPolicy: string | undefined,
): ReturnType<typeof resolveZellijPlacementPolicy> | undefined {
	const agentPolicy = parseEnvString(launchMetadata?.env).PI_SUBAGENT_ZELLIJ_PLACEMENT;
	if (agentPolicy !== undefined) return resolveZellijPlacementPolicy(agentPolicy);
	if (parentPolicy !== undefined) return resolveZellijPlacementPolicy(parentPolicy);
	return launchMetadata?.zellijPlacementPolicy;
}

export function resolveResumeLaunchMetadataForInvocation(
	launchMetadata: PersistedSubagentLaunchMetadata | undefined,
	requestedModel: string | undefined,
	requestedThinking?: string,
	modelRegistry?: ResumeModelRegistry,
): PersistedSubagentLaunchMetadata | undefined {
	if (!launchMetadata || (!requestedModel && !requestedThinking)) return launchMetadata;
	if (launchMetadata.allowModelOverride === false) {
		return {
			...launchMetadata,
			...(requestedModel ? { ignoredModelOverride: requestedModel } : {}),
			...(requestedThinking ? { ignoredThinkingOverride: requestedThinking } : {}),
		};
	}
	const baseModel = requestedModel ?? launchMetadata.modelRef ?? launchMetadata.model;
	if (!baseModel) {
		throw new Error("Cannot apply thinking override without a persisted model.");
	}
	const requested = splitResumeModelRef(baseModel, requestedThinking ?? launchMetadata.thinking);
	const explicitThinking = requested.explicitThinking || requestedThinking != null;
	const resolved = resolveAvailableModelRef(
		requested.model,
		requested.thinking,
		explicitThinking,
		modelRegistry,
		launchMetadata.modelRef,
	);
	const { effectiveModel, effectiveThinking, effectiveModelRef } = normalizeModelRef(
		resolved.model,
		resolved.thinking,
	);
	const implicitDefaultRef = buildModelRef(
		launchMetadata.definitionModel,
		launchMetadata.definitionThinking,
	);
	const implicitAllowed = implicitDefaultRef
		? [implicitDefaultRef]
		: launchMetadata.modelSource === "parent" && launchMetadata.modelRef
			? [launchMetadata.modelRef]
			: [];
	assertModelAllowed(
		effectiveModelRef,
		launchMetadata.allowedModels,
		launchMetadata.name,
		implicitAllowed,
	);
	return {
		...launchMetadata,
		timestamp: new Date().toISOString(),
		model: effectiveModel,
		thinking: effectiveThinking,
		modelRef: effectiveModelRef,
		modelSource: "resume-override",
		...(requestedModel ? { requestedModelOverride: requestedModel } : {}),
		...(requestedThinking ? { requestedThinkingOverride: requestedThinking } : {}),
	};
}

export function mergeResumeInvocationMetadata(
	launchMetadata: PersistedSubagentLaunchMetadata,
	laterMetadata: PersistedSubagentLaunchMetadata,
): PersistedSubagentLaunchMetadata {
	return {
		...launchMetadata,
		...laterMetadata,
		// A child can append metadata to its own session. Keep grant authority
		// anchored to the first launch entry while allowing later entries to
		// carry legitimate invocation changes such as model and thinking.
		spawnBudget: launchMetadata.spawnBudget,
		spawnableAgents: launchMetadata.spawnableAgents,
		denyTools: launchMetadata.denyTools,
	};
}
