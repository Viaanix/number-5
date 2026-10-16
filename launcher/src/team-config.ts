// Reads only what the launcher needs from a docker-agent team.yaml: the agent names
// (to check a manifest's entry points) and the flavor names (the allowed --effort values).
//
// Why the launcher checks flavors itself: docker-agent v1.145.0 treats an unknown
// --flavor as a silent no-op (exit 0, no warning, config unchanged). Without this
// check, `--effort lwo` would run the team at its default effort and nobody would know.
// See docs/docker-agent/gotchas.md.
//
// Flavors named `reviewer-on-<tier>` are not efforts: j5 adds them itself to keep a reviewer
// independent of the builder (launcher/src/independence.ts). They are listed apart, so they are
// never offered as an effort and `--effort reviewer-on-opus` is rejected like any unknown name.

import { readFileSync } from "node:fs";

import { z } from "zod";

import { isReviewerFlavorName } from "./independence.ts";

const teamConfigSchema = z.object({
  agents: z.record(z.string(), z.unknown()),
  flavors: z.record(z.string(), z.unknown()).optional(),
});

/** The parts of a team.yaml the launcher reads. */
export type TeamConfigSummary = {
  agentNames: string[];
  /** The user's effort choices, in declaration order; empty when the team defines none. */
  flavorNames: string[];
  /** Flavors j5 chooses for the reviewer (`reviewer-on-<tier>`), never offered as efforts. */
  reviewerFlavorNames: string[];
};

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
    flavorNames: allFlavorNames.filter((flavorName) => !isReviewerFlavorName(flavorName)),
    reviewerFlavorNames: allFlavorNames.filter((flavorName) => isReviewerFlavorName(flavorName)),
  };
}
