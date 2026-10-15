// Which model each agent of a team really runs on, once flavors are applied.
//
// Only docker-agent knows: a flavor is a YAML patch deep-merged over team.yaml, and an agent
// names a model that may itself be a named entry under `models:`. So this asks
// `docker agent debug config <team.yaml> --flavor ...`, which prints the merged result, instead
// of re-implementing the merge. The command runner is a parameter so tests can supply the output.

import { stripVTControlCharacters } from "node:util";

import { z } from "zod";

import type { AgentModelIds } from "./independence.ts";

const SUCCESS_EXIT_CODE = 0;

/** What running `docker agent <arguments>` produced. */
export type DockerAgentResult = { exitCode: number; standardOutput: string; standardError: string };

/** Runs `docker agent` with the given arguments. */
export type DockerAgentRunner = (dockerAgentArguments: string[]) => DockerAgentResult;

// Loose objects: the resolved config carries many fields this does not read.
const modelReferenceSchema = z.looseObject({ model: z.string().optional() });

const resolvedConfigSchema = z.object({
  agents: z.record(z.string(), modelReferenceSchema),
  models: z.record(z.string(), modelReferenceSchema).default({}),
});

/** The real `docker agent`, run in the team's directory. */
export function createDockerAgentRunner(workingDirectory: string): DockerAgentRunner {
  return (dockerAgentArguments) => {
    try {
      const completedProcess = Bun.spawnSync(["docker", "agent", ...dockerAgentArguments], {
        cwd: workingDirectory,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        exitCode: completedProcess.exitCode,
        standardOutput: completedProcess.stdout.toString(),
        standardError: completedProcess.stderr.toString(),
      };
    } catch (error) {
      return {
        exitCode: 127,
        standardOutput: "",
        standardError: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

/**
 * Returns the model id each agent that has a model runs on, with the flavors applied in order.
 * A named model (`builder_model`) is followed to its `model:` field; an inline reference
 * (`anthropic/claude-sonnet-5-5`) is used as written. Agents without a model (a Claude Code
 * harness agent has none) are left out.
 * @throws Error with docker-agent's own output when it rejects the config.
 */
export function resolveAgentModels(
  teamConfigPath: string,
  flavorNames: string[],
  runDockerAgent: DockerAgentRunner,
): AgentModelIds {
  const flavorArguments = flavorNames.flatMap((flavorName) => ["--flavor", flavorName]);
  const result = runDockerAgent(["debug", "config", teamConfigPath, ...flavorArguments]);
  if (result.exitCode !== SUCCESS_EXIT_CODE) {
    throw new Error(
      `docker agent debug config ${teamConfigPath} failed (exit ${result.exitCode}): ${stripVTControlCharacters(`${result.standardError}${result.standardOutput}`).trim()}`,
    );
  }
  const parsed = resolvedConfigSchema.safeParse(
    Bun.YAML.parse(stripVTControlCharacters(result.standardOutput)),
  );
  if (!parsed.success) {
    throw new Error(
      `docker agent debug config ${teamConfigPath}: unexpected output\n${z.prettifyError(parsed.error)}`,
    );
  }
  const agentModelIds: AgentModelIds = {};
  for (const [agentName, agent] of Object.entries(parsed.data.agents)) {
    if (agent.model === undefined) {
      continue;
    }
    agentModelIds[agentName] = parsed.data.models[agent.model]?.model ?? agent.model;
  }
  return agentModelIds;
}
