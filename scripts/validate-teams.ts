// Validates every team in the repository against the installed docker-agent, without
// calling a model. For each team:
//   1. workflow.yaml parses and passes the launcher's manifest rules;
//   2. every entry point's agent exists in team.yaml;
//   3. `docker agent debug config` accepts team.yaml;
//   4. every flavor parses and changes the resolved config. docker-agent rejects an
//      unknown key inside a flavor, but a flavor that only repeats the base values
//      (e.g. `effort: high` when the base is already high) applies without a word;
//   5. `docker agent run --dry-run` initializes each entry point's agent, with and
//      without each flavor, with the team's bin/ on PATH as the launcher runs it.
//      Step 2 matters because this dry run exits 0 even for an agent name the team
//      does not define (docker-agent v1.145.0).
// Exits 1 when any check fails, after reporting all of them.

import { delimiter, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { readPathValue, withPathValue } from "#launcher/environment.ts";
import { MODEL_TIERS, classifyModel, reviewerFlavorTier } from "#launcher/independence.ts";
import type { WorkflowManifest } from "#launcher/manifest.ts";
import { chooseAutomaticFlavors } from "#launcher/reviewer-flavor.ts";
import { readTeamConfigSummary } from "#launcher/team-config.ts";
import { createDockerAgentRunner, resolveAgentModels } from "#launcher/team-models.ts";
import { discoverTeams, resolveTeamsDirectory } from "#launcher/teams.ts";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const SUCCESS_EXIT_CODE = 0;
const DRY_RUN_MESSAGE = "validate-teams dry run";
// The top-level `flavors:` key and its indented body, up to the next top-level key.
const FLAVORS_SECTION_PATTERN = /^flavors:\n(?:[ \t].*(?:\n|$))*/m;

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

/**
 * Checks a team's independence rule against the installed docker-agent: every `reviewer-on-<tier>`
 * flavor really puts the reviewer on that tier, and for every effort the launcher can choose a
 * flavor that leaves the reviewer in a different class from the agents it reviews. Returns the
 * problems, and the flavors the launcher chooses per effort (undefined = no effort) so the dry
 * runs below use exactly what a real launch would.
 */
function checkIndependence(
  team: WorkflowManifest,
  effortNames: string[],
  reviewerFlavorNames: string[],
): { problems: string[]; automaticFlavorsByEffort: Map<string | undefined, string[]> } {
  const problems: string[] = [];
  const automaticFlavorsByEffort = new Map<string | undefined, string[]>();
  const rule = team.independence;
  if (rule === undefined) {
    if (reviewerFlavorNames.length > 0) {
      problems.push(
        `flavors ${reviewerFlavorNames.join(", ")} look like reviewer flavors, but workflow.yaml has no independence rule to use them`,
      );
    }
    return { problems, automaticFlavorsByEffort };
  }
  const runDockerAgentInTeam = createDockerAgentRunner(team.directory);

  if (reviewerFlavorNames.length === 0) {
    problems.push("independence: team.yaml has no reviewer-on-<tier> flavors to choose from");
  }
  for (const flavorName of reviewerFlavorNames) {
    const tier = reviewerFlavorTier(flavorName);
    if (tier === undefined) {
      problems.push(
        `flavor ${flavorName}: the part after 'reviewer-on-' must be one of ${MODEL_TIERS.join(", ")}`,
      );
      continue;
    }
    try {
      const models = resolveAgentModels(team.teamConfigPath, [flavorName], runDockerAgentInTeam);
      const reviewerModel = models[rule.reviewer];
      if (reviewerModel === undefined || classifyModel(reviewerModel) !== tier) {
        problems.push(
          `flavor ${flavorName}: puts reviewer '${rule.reviewer}' on ${reviewerModel ?? "no model"}, not on a ${tier} model`,
        );
      }
    } catch (error) {
      problems.push(
        `flavor ${flavorName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const effort of [undefined, ...effortNames]) {
    try {
      const chosen = chooseAutomaticFlavors(team, effort, [], runDockerAgentInTeam);
      automaticFlavorsByEffort.set(effort, chosen.flavorNames);
    } catch (error) {
      problems.push(
        `effort ${effort ?? "none"}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { problems, automaticFlavorsByEffort };
}

function validateTeam(team: WorkflowManifest): string[] {
  const problems: string[] = [];
  const { agentNames, flavorNames, reviewerFlavorNames } = readTeamConfigSummary(
    team.teamConfigPath,
  );

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
  // The resolved config of the base still lists the flavors; with a flavor applied
  // the list is dropped. Compare without it so only real patches count as a change.
  const baseWithoutFlavors = baseConfig.output.replace(FLAVORS_SECTION_PATTERN, "").trim();

  for (const flavorName of flavorNames) {
    const flavoredConfig = runDockerAgent(
      ["debug", "config", team.teamConfigPath, "--flavor", flavorName],
      team,
    );
    if (flavoredConfig.exitCode !== SUCCESS_EXIT_CODE) {
      problems.push(`flavor ${flavorName}: debug config failed:\n${flavoredConfig.output}`);
    } else if (flavoredConfig.output.trim() === baseWithoutFlavors) {
      problems.push(
        `flavor ${flavorName}: changes nothing — check its key paths against team.yaml`,
      );
    }
  }

  const independence = checkIndependence(team, flavorNames, reviewerFlavorNames);
  problems.push(...independence.problems);

  const entryPointAgents = [
    ...new Set(Object.values(team.entrypoints).map((entry) => entry.agent)),
  ];
  const flavorVariants: Array<string | undefined> = [undefined, ...flavorNames];
  for (const agentName of entryPointAgents) {
    for (const flavorName of flavorVariants) {
      // The flavors a real launch uses: the effort, then the ones j5 chooses for the reviewer.
      const flavorArguments = [
        ...(flavorName === undefined ? [] : [flavorName]),
        ...(independence.automaticFlavorsByEffort.get(flavorName) ?? []),
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
          `dry run of agent ${agentName} (flavor ${flavorName ?? "none"}) failed:\n${dryRun.output}`,
        );
      }
    }
  }
  return problems;
}

function main(): number {
  let teams: WorkflowManifest[];
  try {
    teams = discoverTeams(REPOSITORY_ROOT);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (teams.length === 0) {
    console.error(`no team manifests under ${resolveTeamsDirectory(REPOSITORY_ROOT)}`);
    return 1;
  }

  let failedTeamCount = 0;
  for (const team of teams) {
    const problems = validateTeam(team);
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
