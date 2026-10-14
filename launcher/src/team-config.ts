// Reads only what the launcher needs from a docker-agent team.yaml: the agent names
// (to check a manifest's entry points) and the flavor names (the allowed --effort values).
//
// Why the launcher checks flavors itself: docker-agent v1.145.0 treats an unknown
// --flavor as a silent no-op (exit 0, no warning, config unchanged). Without this
// check, `--effort lwo` would run the team at its default effort and nobody would know.
// See docs/docker-agent/gotchas.md.

import { readFileSync } from "node:fs";

import { z } from "zod";

const teamConfigSchema = z.object({
  agents: z.record(z.string(), z.unknown()),
  flavors: z.record(z.string(), z.unknown()).optional(),
});

/** The parts of a team.yaml the launcher reads. */
export type TeamConfigSummary = {
  agentNames: string[];
  /** Flavor names in declaration order; empty when the team defines none. */
  flavorNames: string[];
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
  return {
    agentNames: Object.keys(parseResult.data.agents),
    flavorNames: Object.keys(parseResult.data.flavors ?? {}),
  };
}
