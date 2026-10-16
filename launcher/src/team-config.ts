// Reads only what the launcher needs from a docker-agent team.yaml: the agent names
// (to check a manifest's entry points) and which standard flavors the team defines
// (the allowed --model and --effort values).
//
// Why the launcher checks flavors itself: docker-agent v1.145.0 treats an unknown
// --flavor as a silent no-op (exit 0, no warning, config unchanged). Without this
// check, `--effort hihg` would run the team at its default effort and nobody would know.
// See docs/docker-agent/gotchas.md.
//
// The flavor names are a contract (launcher/src/flavor-catalog.ts): `model-<tier>` and
// `effort-<level>` are the user's choices, `reviewer-on-<tier>` is j5's own, to keep a reviewer
// independent of the builder (launcher/src/independence.ts), and is never offered to the user.
// `queue-unattended` is j5's too: it is added to queue runs of an entry point that approves tools.

import { readFileSync } from "node:fs";

import { z } from "zod";

import { EFFORT_FLAVOR_PREFIX, MODEL_FLAVOR_PREFIX, QUEUE_FLAVOR_NAME } from "./flavor-catalog.ts";
import { isReviewerFlavorName } from "./independence.ts";

const teamConfigSchema = z.object({
  agents: z.record(z.string(), z.unknown()),
  flavors: z.record(z.string(), z.unknown()).optional(),
});

/** The parts of a team.yaml the launcher reads. */
export type TeamConfigSummary = {
  agentNames: string[];
  /** The tiers `--model` accepts (from `model-<tier>` flavors), in declaration order. */
  modelTiers: string[];
  /** The levels `--effort` accepts (from `effort-<level>` flavors), in declaration order. */
  effortLevels: string[];
  /** Flavors j5 chooses for the reviewer (`reviewer-on-<tier>`), never offered to the user. */
  reviewerFlavorNames: string[];
  /** Flavors no launch option reaches; `validate:teams` rejects them. */
  otherFlavorNames: string[];
};

function namesWithPrefix(flavorNames: string[], prefix: string): string[] {
  return flavorNames
    .filter((flavorName) => flavorName.startsWith(prefix))
    .map((flavorName) => flavorName.slice(prefix.length));
}

/**
 * Reads agent and flavor names from a docker-agent team configuration.
 * @throws Error when the file is not YAML or has no `agents` map.
 */
export function readTeamConfigSummary(teamConfigPath: string): TeamConfigSummary {
  const rawDocument: unknown = Bun.YAML.parse(readFileSync(teamConfigPath, "utf8"));
  const parseResult = teamConfigSchema.safeParse(rawDocument);
  if (!parseResult.success) {
    throw new Error(`${teamConfigPath}: not a team config\n${z.prettifyError(parseResult.error)}`);
  }
  const allFlavorNames = Object.keys(parseResult.data.flavors ?? {});
  return {
    agentNames: Object.keys(parseResult.data.agents),
    modelTiers: namesWithPrefix(allFlavorNames, MODEL_FLAVOR_PREFIX),
    effortLevels: namesWithPrefix(allFlavorNames, EFFORT_FLAVOR_PREFIX),
    reviewerFlavorNames: allFlavorNames.filter((flavorName) => isReviewerFlavorName(flavorName)),
    otherFlavorNames: allFlavorNames.filter(
      (flavorName) =>
        !flavorName.startsWith(MODEL_FLAVOR_PREFIX) &&
        !flavorName.startsWith(EFFORT_FLAVOR_PREFIX) &&
        flavorName !== QUEUE_FLAVOR_NAME &&
        !isReviewerFlavorName(flavorName),
    ),
  };
}
