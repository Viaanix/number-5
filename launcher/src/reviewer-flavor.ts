// The launch-time step of the independence rule: from the models the builders run on (after the
// flavors the user chose with --model and --effort), pick the reviewer's tier, add the flavor
// that puts the reviewer on it, and check the result before anything is launched.
//
// Why a flavor and not `docker agent run --model reviewer=...`: the flavor is a patch of the
// reviewer's named model in team.yaml, so its settings (the reasoning effort the Claude models
// need) stay. `docker agent debug config` has no `--model` either, so a `--model` override could
// change the reviewer without this step ever seeing it; see rejectConflictingPassthrough.

import {
  chooseReviewer,
  findIndependenceProblems,
  IndependenceError,
  reviewerFlavorTier,
  type ModelTier,
} from "./independence.ts";
import type { WorkflowManifest } from "./manifest.ts";
import { readTeamConfigSummary } from "./team-config.ts";
import { type DockerAgentRunner, resolveAgentModels } from "./team-models.ts";

// docker-agent flags that change which model an agent uses, and so could break the rule unseen.
const MODEL_CHANGING_FLAGS = ["--model", "--flavor"];

/** The flavors j5 adds on top of the user's, and a line saying why. */
export type AutomaticFlavors = { flavorNames: string[]; explanation: string | undefined };

const NO_AUTOMATIC_FLAVORS: AutomaticFlavors = { flavorNames: [], explanation: undefined };

function isModelChangingFlag(argument: string): boolean {
  return MODEL_CHANGING_FLAGS.some((flag) => argument === flag || argument.startsWith(`${flag}=`));
}

/**
 * Refuses `--model` and `--flavor` after `--` for a team with an independence rule: they would
 * change the models after the rule was checked.
 * @throws IndependenceError naming the flag.
 */
function rejectConflictingPassthrough(passthroughArguments: string[], teamName: string): void {
  const conflicting = passthroughArguments.find((argument) => isModelChangingFlag(argument));
  if (conflicting !== undefined) {
    throw new IndependenceError(
      `${conflicting} after '--' would change the models ${teamName} keeps independent; choose them with --model and --effort, or edit team.yaml`,
    );
  }
}

/** The tiers the team offers a reviewer: its `reviewer-on-<tier>` flavors that name a real tier. */
export function offeredReviewerTiers(teamConfigPath: string): ModelTier[] {
  return readTeamConfigSummary(teamConfigPath)
    .reviewerFlavorNames.map((flavorName) => reviewerFlavorTier(flavorName))
    .filter((tier): tier is ModelTier => tier !== undefined);
}

/**
 * Works out the flavors to add for this launch. For a team without an independence rule, none.
 * @throws IndependenceError when no tier is independent, the models cannot be classified, a
 *   `--model` / `--flavor` passthrough conflicts, or the flavor does not produce an independent
 *   reviewer (a flavor that patches the wrong model).
 * @throws Error with docker-agent's own output when it rejects the config.
 */
export function chooseAutomaticFlavors(
  team: WorkflowManifest,
  userFlavors: string[],
  passthroughArguments: string[],
  runDockerAgent: DockerAgentRunner,
): AutomaticFlavors {
  const rule = team.independence;
  if (rule === undefined) {
    return NO_AUTOMATIC_FLAVORS;
  }
  rejectConflictingPassthrough(passthroughArguments, team.name);

  const beforeReview = resolveAgentModels(team.teamConfigPath, userFlavors, runDockerAgent);
  const choice = chooseReviewer(rule, offeredReviewerTiers(team.teamConfigPath), beforeReview);

  const afterReview = resolveAgentModels(
    team.teamConfigPath,
    [...userFlavors, choice.flavorName],
    runDockerAgent,
  );
  const problems = findIndependenceProblems(rule, afterReview);
  if (problems.length > 0) {
    throw new IndependenceError(
      `flavor ${choice.flavorName} did not make the review independent: ${problems.join("; ")}`,
    );
  }
  return { flavorNames: [choice.flavorName], explanation: choice.explanation };
}
