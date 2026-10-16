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
const agentSchema = z.looseObject({ model: z.string().optional() });
const namedModelSchema = z.looseObject({
  model: z.string().optional(),
  provider_opts: z
    .looseObject({
      extra_body: z.looseObject({ reasoning_effort: z.string().optional() }).optional(),
    })
    .optional(),
});

const resolvedConfigSchema = z.object({
  agents: z.record(z.string(), agentSchema),
  models: z.record(z.string(), namedModelSchema).default({}),
});

type ResolvedConfig = z.infer<typeof resolvedConfigSchema>;

/** What a named entry under `models:` resolves to once flavors are applied. */
export type NamedModelSettings = {
  modelId: string | undefined;
  reasoningEffort: string | undefined;
};

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

function readResolvedConfig(
  teamConfigPath: string,
  flavorNames: string[],
  runDockerAgent: DockerAgentRunner,
): ResolvedConfig {
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
  return parsed.data;
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
  const { agents, models } = readResolvedConfig(teamConfigPath, flavorNames, runDockerAgent);
  const agentModelIds: AgentModelIds = {};
  for (const [agentName, agent] of Object.entries(agents)) {
    if (agent.model === undefined) {
      continue;
    }
    agentModelIds[agentName] = models[agent.model]?.model ?? agent.model;
  }
  return agentModelIds;
}

/**
 * Returns the model id and reasoning effort of every named entry under `models:`, with the
 * flavors applied in order. This is what a launch option really changed, whichever agents use it.
 * @throws Error with docker-agent's own output when it rejects the config.
 */
export function resolveNamedModels(
  teamConfigPath: string,
  flavorNames: string[],
  runDockerAgent: DockerAgentRunner,
): Record<string, NamedModelSettings> {
  const { models } = readResolvedConfig(teamConfigPath, flavorNames, runDockerAgent);
  return Object.fromEntries(
    Object.entries(models).map(([modelName, model]) => [
      modelName,
      { modelId: model.model, reasoningEffort: model.provider_opts?.extra_body?.reasoning_effort },
    ]),
  );
}
