// Keeping a reviewer independent of the model that built the change.
//
// A model reviewing its own class of output shares its blind spots, so a review by the same
// kind of model is worth less than it looks. A team can declare that one agent (the reviewer)
// reviews the work of others; j5 then picks the reviewer's model tier from the builders' tiers
// and refuses to launch a run where they end up the same.
//
// "Class" here is the tier of the model: haiku, sonnet, opus or fable, whatever its version.
// Sonnet 5.5 and Sonnet 4.6 are the same class; Sonnet and Opus are not.
//
// Everything in this file is pure. Resolving which model an agent really uses is
// team-models.ts; applying the choice at launch is reviewer-flavor.ts.

import type { IndependenceRule } from "./manifest.ts";

/** Model tiers from the smallest to the largest. The order is the ladder a review climbs. */
export const MODEL_TIERS = ["haiku", "sonnet", "opus", "fable"] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * Prefix of the team.yaml flavors that move the reviewer onto a tier: `reviewer-on-opus` puts
 * the reviewer on an Opus model. They are chosen by j5, never by the user, so they are not
 * offered as efforts.
 */
export const REVIEWER_FLAVOR_PREFIX = "reviewer-on-";

/** A rule that cannot be satisfied or was broken; the message says which and why. */
export class IndependenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndependenceError";
  }
}

function isModelTier(name: string): name is ModelTier {
  return (MODEL_TIERS as readonly string[]).includes(name);
}

/** The tier a model id belongs to, or undefined when its id names none or more than one. */
export function classifyModel(modelId: string): ModelTier | undefined {
  // Drop a provider prefix ("anthropic/claude-opus-4-7"), then look at each dash-separated word,
  // which finds the tier wherever the id puts it: claude-sonnet-5-5, claude-3-5-sonnet-20241022.
  // An id that spells its tier another way is not guessed at; it is refused as unclassifiable.
  const bareModelId = (modelId.split("/").at(-1) ?? modelId).toLowerCase();
  const tiersNamed = [...new Set(bareModelId.split("-"))].filter(isModelTier);
  return tiersNamed.length === 1 ? tiersNamed[0] : undefined;
}

/** The tier a flavor name asks for (`reviewer-on-opus` is `opus`), or undefined if it is not one. */
export function reviewerFlavorTier(flavorName: string): ModelTier | undefined {
  if (!flavorName.startsWith(REVIEWER_FLAVOR_PREFIX)) {
    return undefined;
  }
  const tierName = flavorName.slice(REVIEWER_FLAVOR_PREFIX.length);
  return isModelTier(tierName) ? tierName : undefined;
}

/** True for any flavor name that j5 chooses itself, valid or not. */
export function isReviewerFlavorName(flavorName: string): boolean {
  return flavorName.startsWith(REVIEWER_FLAVOR_PREFIX);
}

/**
 * Chooses the tier the reviewer should run on, from the tiers of the models whose work it reviews
 * and the tiers the team offers. In order of preference:
 *   1. one step up: the lowest offered tier above every reviewed tier;
 *   2. when nothing above is offered (the builder is already on the top tier), the nearest offered
 *      tier below every reviewed tier;
 *   3. an offered tier between them, when the reviewed tiers straddle it.
 * Undefined when every offered tier is one of the reviewed tiers.
 */
export function chooseReviewerTier(
  reviewedTiers: ModelTier[],
  offeredTiers: ModelTier[],
): ModelTier | undefined {
  if (reviewedTiers.length === 0) {
    return undefined;
  }
  const indexOf = (tier: ModelTier): number => MODEL_TIERS.indexOf(tier);
  const reviewedIndexes = reviewedTiers.map(indexOf);
  const highestReviewedIndex = Math.max(...reviewedIndexes);
  const lowestReviewedIndex = Math.min(...reviewedIndexes);
  const differentTiers = [...new Set(offeredTiers)]
    .filter((tier) => !reviewedTiers.includes(tier))
    .toSorted((left, right) => indexOf(left) - indexOf(right));

  const oneStepUp = differentTiers.find((tier) => indexOf(tier) > highestReviewedIndex);
  const nearestBelow = differentTiers.findLast((tier) => indexOf(tier) < lowestReviewedIndex);
  return oneStepUp ?? nearestBelow ?? differentTiers.at(-1);
}

/** The model each agent really runs on, by agent name. */
export type AgentModelIds = Record<string, string>;

/** Names the agent and tier for each of these agents, or says why one cannot be classified. */
function describeTiers(
  agentNames: string[],
  agentModelIds: AgentModelIds,
): { tiers: Map<string, ModelTier>; problems: string[] } {
  const tiers = new Map<string, ModelTier>();
  const problems: string[] = [];
  for (const agentName of agentNames) {
    const modelId = agentModelIds[agentName];
    if (modelId === undefined) {
      problems.push(`agent '${agentName}' has no model in the resolved team config`);
      continue;
    }
    const tier = classifyModel(modelId);
    if (tier === undefined) {
      problems.push(
        `agent '${agentName}' runs '${modelId}', which names none of the tiers ${MODEL_TIERS.join(", ")}; teach classifyModel in launcher/src/independence.ts about it`,
      );
      continue;
    }
    tiers.set(agentName, tier);
  }
  return { tiers, problems };
}

/** Problems that stop a rule being checked or being met; empty means the reviewer is independent. */
export function findIndependenceProblems(
  rule: IndependenceRule,
  agentModelIds: AgentModelIds,
): string[] {
  const { tiers, problems } = describeTiers([rule.reviewer, ...rule.reviews], agentModelIds);
  if (problems.length > 0) {
    return problems;
  }
  const reviewerTier = tiers.get(rule.reviewer);
  const sameClass = rule.reviews.filter((agentName) => tiers.get(agentName) === reviewerTier);
  if (sameClass.length === 0) {
    return [];
  }
  const shared = sameClass.map((agentName) => `${agentName} (${agentModelIds[agentName]})`);
  return [
    `reviewer '${rule.reviewer}' runs ${agentModelIds[rule.reviewer]}, the same class (${reviewerTier}) as ${shared.join(", ")}`,
  ];
}

/** What j5 decided for a launch: the flavor to add, and a line saying why. */
export type ReviewerChoice = { flavorName: string; tier: ModelTier; explanation: string };

/**
 * Picks the reviewer's tier and the flavor that applies it.
 * @throws IndependenceError when the agents' models cannot be classified, or the team offers no
 *   tier different from all of the reviewed ones.
 */
export function chooseReviewer(
  rule: IndependenceRule,
  offeredTiers: ModelTier[],
  agentModelIds: AgentModelIds,
): ReviewerChoice {
  const { tiers, problems } = describeTiers(rule.reviews, agentModelIds);
  if (problems.length > 0) {
    throw new IndependenceError(problems.join("; "));
  }
  const reviewedTiers = [...tiers.values()];
  const tier = chooseReviewerTier(reviewedTiers, offeredTiers);
  if (tier === undefined) {
    throw new IndependenceError(
      `no reviewer tier differs from ${[...tiers].map(([name, found]) => `${name} (${found})`).join(", ")}; the team offers ${offeredTiers.length === 0 ? "none" : offeredTiers.join(", ")} (flavors ${REVIEWER_FLAVOR_PREFIX}<tier> in team.yaml)`,
    );
  }
  const reviewed = [...tiers].map(([name, found]) => `${name} ${found}`).join(", ");
  return {
    flavorName: `${REVIEWER_FLAVOR_PREFIX}${tier}`,
    tier,
    explanation: `reviewer '${rule.reviewer}' runs on ${tier} (${reviewed}), so the review is independent`,
  };
}
