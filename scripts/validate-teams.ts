// Validates every team in the repository against the installed docker-agent, without
// calling a model. For each team:
//   1. workflow.yaml parses and passes the launcher's manifest rules;
//   2. every entry point's agent exists in team.yaml;
//   3. `docker agent debug config` accepts team.yaml;
//   4. the generated flavors block in team.yaml is what `bun run flavors` would write, and
//      no flavor has a name the launcher cannot select;
//   5. every flavor does what its name says, read from docker-agent's merged config: each
//      model-<tier> puts the team's tunable models on that tier, each effort-<level> sets that
//      reasoning effort on them (and on the reviewer), each reviewer-on-<tier> puts the
//      independence reviewer on that tier. A flavor that repeats the base values changes
//      nothing and applies without a word, so this compares against the name, not the base;
//   6. for a team with an independence rule, every combination of --model and --effort leaves
//      the launcher a reviewer tier that differs from the agents it reviews;
//   7. `docker agent run --dry-run` initializes each entry point's agent, with and without
//      each flavor, with the team's bin/ on PATH as the launcher runs it.
//      Step 2 matters because this dry run exits 0 even for an agent name the team
//      does not define (docker-agent v1.145.0).
// Exits 1 when any check fails, after reporting all of them.

import { readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { readPathValue, withPathValue } from "#launcher/environment.ts";
import {
  FLAVOR_CATALOG_FILE_NAME,
  EFFORT_FLAVOR_PREFIX,
  MODEL_FLAVOR_PREFIX,
  hasGeneratedSection,
  loadFlavorCatalog,
  planTeamFlavors,
  replaceGeneratedSection,
  resolveTuning,
  type FlavorCatalog,
} from "#launcher/flavor-catalog.ts";
import {
  MODEL_TIERS,
  REVIEWER_FLAVOR_PREFIX,
  classifyModel,
  reviewerFlavorTier,
} from "#launcher/independence.ts";
import type { WorkflowManifest } from "#launcher/manifest.ts";
import { chooseAutomaticFlavors } from "#launcher/reviewer-flavor.ts";
import { readTeamConfigSummary } from "#launcher/team-config.ts";
import {
  createDockerAgentRunner,
  resolveAgentModels,
  resolveNamedModels,
  type DockerAgentRunner,
} from "#launcher/team-models.ts";
import { discoverTeams, resolveTeamsDirectory } from "#launcher/teams.ts";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const SUCCESS_EXIT_CODE = 0;
const DRY_RUN_MESSAGE = "validate-teams dry run";

type CommandResult = { exitCode: number; output: string };

function runDockerAgent(dockerAgentArguments: string[], team: WorkflowManifest): CommandResult {
  const completedProcess = Bun.spawnSync(["docker", "agent", ...dockerAgentArguments], {
    cwd: team.directory,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: withPathValue(
      process.env,
      [...team.pathDirectories, readPathValue(process.env)].join(delimiter),
    ),
  });
  return {
    exitCode: completedProcess.exitCode,
    // docker-agent colors its parse errors; the escape codes are noise in this report.
    output: stripVTControlCharacters(
      `${completedProcess.stdout.toString()}${completedProcess.stderr.toString()}`,
    ).trim(),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Step 4: the generated block is current, and every flavor name is one the launcher selects. */
function checkGeneratedFlavors(
  team: WorkflowManifest,
  catalog: FlavorCatalog,
  otherFlavorNames: string[],
): string[] {
  const problems: string[] = [];
  if (otherFlavorNames.length > 0) {
    problems.push(
      `flavors ${otherFlavorNames.join(", ")}: the launcher selects only model-<tier>, effort-<level> and reviewer-on-<tier>; no option reaches these`,
    );
  }
  const { section, problems: planProblems } = planTeamFlavors(catalog, team);
  if (planProblems.length > 0) {
    return [...problems, ...planProblems];
  }
  const teamYamlText = readFileSync(team.teamConfigPath, "utf8");
  if (section === undefined) {
    if (hasGeneratedSection(teamYamlText)) {
      problems.push("team.yaml has a generated flavors block but workflow.yaml has no `flavors:`");
    }
    return problems;
  }
  try {
    if (replaceGeneratedSection(teamYamlText, section) !== teamYamlText) {
      problems.push("the generated flavors in team.yaml are out of date; run `bun run flavors`");
    }
  } catch (error) {
    problems.push(describeError(error));
  }
  return problems;
}

/** Step 5: each flavor does what its name says, per docker-agent's merged config. */
function checkFlavorEffects(
  team: WorkflowManifest,
  modelTiers: string[],
  effortLevels: string[],
  reviewerFlavorNames: string[],
  runDockerAgentInTeam: DockerAgentRunner,
): string[] {
  const problems: string[] = [];
  const { tuning } = resolveTuning(
    team.flavors?.models ?? [],
    team.independence?.reviewer,
    readFileSync(team.teamConfigPath, "utf8"),
  );
  const effortModels = [...tuning.tunableModels, ...tuning.reviewerModels];

  for (const tier of modelTiers) {
    const flavorName = `${MODEL_FLAVOR_PREFIX}${tier}`;
    if (!(MODEL_TIERS as readonly string[]).includes(tier)) {
      problems.push(`flavor ${flavorName}: '${tier}' is not one of ${MODEL_TIERS.join(", ")}`);
      continue;
    }
    try {
      const named = resolveNamedModels(team.teamConfigPath, [flavorName], runDockerAgentInTeam);
      for (const modelName of tuning.tunableModels) {
        const modelId = named[modelName]?.modelId;
        if (modelId === undefined || classifyModel(modelId) !== tier) {
          problems.push(
            `flavor ${flavorName}: puts ${modelName} on ${modelId ?? "no model"}, not on a ${tier} model`,
          );
        }
      }
    } catch (error) {
      problems.push(`flavor ${flavorName}: ${describeError(error)}`);
    }
  }

  for (const level of effortLevels) {
    const flavorName = `${EFFORT_FLAVOR_PREFIX}${level}`;
    try {
      const named = resolveNamedModels(team.teamConfigPath, [flavorName], runDockerAgentInTeam);
      for (const modelName of effortModels) {
        const effort = named[modelName]?.reasoningEffort;
        if (effort !== level) {
          problems.push(
            `flavor ${flavorName}: sets ${modelName} to reasoning effort ${effort ?? "none"}, not ${level}`,
          );
        }
      }
    } catch (error) {
      problems.push(`flavor ${flavorName}: ${describeError(error)}`);
    }
  }

  const rule = team.independence;
  for (const flavorName of reviewerFlavorNames) {
    const tier = reviewerFlavorTier(flavorName);
    if (tier === undefined) {
      problems.push(
        `flavor ${flavorName}: the part after '${REVIEWER_FLAVOR_PREFIX}' must be one of ${MODEL_TIERS.join(", ")}`,
      );
    } else if (rule === undefined) {
      problems.push(`flavor ${flavorName}: workflow.yaml has no independence rule to use it`);
    } else {
      try {
        const models = resolveAgentModels(team.teamConfigPath, [flavorName], runDockerAgentInTeam);
        const reviewerModel = models[rule.reviewer];
        if (reviewerModel === undefined || classifyModel(reviewerModel) !== tier) {
          problems.push(
            `flavor ${flavorName}: puts reviewer '${rule.reviewer}' on ${reviewerModel ?? "no model"}, not on a ${tier} model`,
          );
        }
      } catch (error) {
        problems.push(`flavor ${flavorName}: ${describeError(error)}`);
      }
    }
  }
  return problems;
}

/** Every way a user can combine --model and --effort, each as the flavors it selects. */
function userFlavorCombinations(modelTiers: string[], effortLevels: string[]): string[][] {
  const modelChoices = [undefined, ...modelTiers.map((tier) => `${MODEL_FLAVOR_PREFIX}${tier}`)];
  const effortChoices = [
    undefined,
    ...effortLevels.map((level) => `${EFFORT_FLAVOR_PREFIX}${level}`),
  ];
  return modelChoices.flatMap((modelFlavor) =>
    effortChoices.map((effortFlavor) =>
      [modelFlavor, effortFlavor].filter((flavor): flavor is string => flavor !== undefined),
    ),
  );
}

/**
 * Step 6: for every combination of --model and --effort the launcher can choose a reviewer tier
 * that differs from the agents it reviews. Returns the problems, and the flavors the launcher
 * chooses per combination (keyed by the user's flavors joined with a comma) so the dry runs use
 * exactly what a real launch would.
 */
function checkIndependence(
  team: WorkflowManifest,
  combinations: string[][],
  runDockerAgentInTeam: DockerAgentRunner,
): { problems: string[]; automaticFlavorsByKey: Map<string, string[]> } {
  const problems: string[] = [];
  const automaticFlavorsByKey = new Map<string, string[]>();
  if (team.independence === undefined) {
    return { problems, automaticFlavorsByKey };
  }
  for (const userFlavors of combinations) {
    try {
      const chosen = chooseAutomaticFlavors(team, userFlavors, [], runDockerAgentInTeam);
      automaticFlavorsByKey.set(userFlavors.join(","), chosen.flavorNames);
    } catch (error) {
      problems.push(`flavors [${userFlavors.join(", ") || "none"}]: ${describeError(error)}`);
    }
  }
  return { problems, automaticFlavorsByKey };
}

function validateTeam(team: WorkflowManifest, catalog: FlavorCatalog): string[] {
  const problems: string[] = [];
  const { agentNames, modelTiers, effortLevels, reviewerFlavorNames, otherFlavorNames } =
    readTeamConfigSummary(team.teamConfigPath);
  const runDockerAgentInTeam = createDockerAgentRunner(team.directory);

  for (const [entryPointName, entryPoint] of Object.entries(team.entrypoints)) {
    if (!agentNames.includes(entryPoint.agent)) {
      problems.push(
        `entry point ${entryPointName}: agent '${entryPoint.agent}' is not in team.yaml`,
      );
    }
  }

  const baseConfig = runDockerAgent(["debug", "config", team.teamConfigPath], team);
  if (baseConfig.exitCode !== SUCCESS_EXIT_CODE) {
    problems.push(`docker agent debug config failed:\n${baseConfig.output}`);
    return problems;
  }

  problems.push(...checkGeneratedFlavors(team, catalog, otherFlavorNames));
  problems.push(
    ...checkFlavorEffects(
      team,
      modelTiers,
      effortLevels,
      reviewerFlavorNames,
      runDockerAgentInTeam,
    ),
  );
  if (team.independence !== undefined && reviewerFlavorNames.length === 0) {
    problems.push("independence: team.yaml has no reviewer-on-<tier> flavors to choose from");
  }

  const combinations = userFlavorCombinations(modelTiers, effortLevels);
  const independence = checkIndependence(team, combinations, runDockerAgentInTeam);
  problems.push(...independence.problems);

  // Dry-run the team as launched: no flavor, each flavor alone, and one of each together. The
  // full matrix is checked above from the merged config, which is much cheaper than a dry run.
  const dryRunVariants: string[][] = [
    [],
    ...modelTiers.map((tier) => [`${MODEL_FLAVOR_PREFIX}${tier}`]),
    ...effortLevels.map((level) => [`${EFFORT_FLAVOR_PREFIX}${level}`]),
  ];
  const firstModelTier = modelTiers[0];
  const firstEffortLevel = effortLevels[0];
  if (firstModelTier !== undefined && firstEffortLevel !== undefined) {
    dryRunVariants.push([
      `${MODEL_FLAVOR_PREFIX}${firstModelTier}`,
      `${EFFORT_FLAVOR_PREFIX}${firstEffortLevel}`,
    ]);
  }
  const entryPointAgents = [
    ...new Set(Object.values(team.entrypoints).map((entry) => entry.agent)),
  ];
  for (const agentName of entryPointAgents) {
    for (const userFlavors of dryRunVariants) {
      // The flavors a real launch uses: the user's, then the ones j5 chooses for the reviewer.
      const flavorArguments = [
        ...userFlavors,
        ...(independence.automaticFlavorsByKey.get(userFlavors.join(",")) ?? []),
      ].flatMap((flavor) => ["--flavor", flavor]);
      const dryRun = runDockerAgent(
        [
          "run",
          team.teamConfigPath,
          "--agent",
          agentName,
          ...flavorArguments,
          "--dry-run",
          "--exec",
          DRY_RUN_MESSAGE,
        ],
        team,
      );
      if (dryRun.exitCode !== SUCCESS_EXIT_CODE) {
        problems.push(
          `dry run of agent ${agentName} (flavors ${userFlavors.join(", ") || "none"}) failed:\n${dryRun.output}`,
        );
      }
    }
  }
  return problems;
}

function main(): number {
  let teams: WorkflowManifest[];
  let catalog: FlavorCatalog;
  try {
    teams = discoverTeams(REPOSITORY_ROOT);
    catalog = loadFlavorCatalog(
      join(resolveTeamsDirectory(REPOSITORY_ROOT), FLAVOR_CATALOG_FILE_NAME),
    );
  } catch (error) {
    console.error(describeError(error));
    return 1;
  }
  if (teams.length === 0) {
    console.error(`no team manifests under ${resolveTeamsDirectory(REPOSITORY_ROOT)}`);
    return 1;
  }

  let failedTeamCount = 0;
  for (const team of teams) {
    const problems = validateTeam(team, catalog);
    if (problems.length === 0) {
      console.log(`ok   ${team.name}`);
    } else {
      failedTeamCount += 1;
      console.log(`FAIL ${team.name}`);
      for (const problem of problems) {
        console.log(`  - ${problem.replaceAll("\n", "\n    ")}`);
      }
    }
  }
  return failedTeamCount === 0 ? 0 : 1;
}

process.exit(main());
