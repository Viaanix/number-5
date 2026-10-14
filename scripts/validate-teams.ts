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

import { readPathValue, withPathValue } from "../launcher/src/environment.ts";
import type { WorkflowManifest } from "../launcher/src/manifest.ts";
import { readTeamConfigSummary } from "../launcher/src/team-config.ts";
import { discoverTeams, resolveTeamsDirectory } from "../launcher/src/teams.ts";

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

function validateTeam(team: WorkflowManifest): string[] {
  const problems: string[] = [];
  const { agentNames, flavorNames } = readTeamConfigSummary(team.teamConfigPath);

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

  const entryPointAgents = [
    ...new Set(Object.values(team.entrypoints).map((entry) => entry.agent)),
  ];
  const flavorVariants: Array<string | undefined> = [undefined, ...flavorNames];
  for (const agentName of entryPointAgents) {
    for (const flavorName of flavorVariants) {
      const flavorArguments = flavorName === undefined ? [] : ["--flavor", flavorName];
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
