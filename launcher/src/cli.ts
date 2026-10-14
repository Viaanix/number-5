// `daw` — the universal launcher for the docker-agent teams in this repository.
// It picks a team and entry point, a project checkout, a base branch, an effort
// (a docker-agent flavor) and the entry point's parameters, from flags or by asking,
// then runs `docker agent run` with the team's helper scripts on PATH.
//
// Every value can come from a flag; anything missing is asked for when stdin and
// stdout are a terminal, and is an error otherwise. `--print` shows the exact
// command instead of running it.

import { basename, resolve } from "node:path";

import { findUnknownOptionNames, type ParsedArguments, parseArguments } from "./arguments.ts";
import {
  inspectPullRequestWorktree,
  listRemoteBranches,
  type PullRequestWorktreeState,
  refExists,
  resolveDefaultBranchRef,
  resolveGitToplevel,
} from "./git.ts";
import type { EntryPointDefinition, WorkflowManifest } from "./manifest.ts";
import { describeInvalidEffort, describeInvalidParameterValue } from "./parameters.ts";
import { buildLaunchPlan, type LaunchPlan } from "./plan.ts";
import {
  askForText,
  askToChoose,
  askToConfirm,
  LaunchCancelledError,
  showNote,
} from "./prompts.ts";
import { renderPlanAsShellCommand } from "./shell-quote.ts";
import { readTeamConfigSummary } from "./team-config.ts";
import { discoverTeams } from "./teams.ts";

// This file lives at <repository>/launcher/src/cli.ts; teams are top-level directories.
const LAUNCHER_REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..");

const EXIT_CODE_SUCCESS = 0;
const EXIT_CODE_FAILURE = 1;
const EXIT_CODE_USAGE = 2;
// Conventional exit status for "interrupted by Ctrl-C" (128 + SIGINT).
const EXIT_CODE_CANCELLED = 130;

const LIST_COMMAND = "list";

// Value of the effort choice that passes no --flavor. Empty because a flavor name never is.
const TEAM_DEFAULT_EFFORT_CHOICE = "";

/** A mistake in how daw was called; reported with a pointer to --help. */
class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** What the launcher may do to fill in missing values. */
type Interaction = {
  canPrompt: boolean;
  /** Set once any question was asked; the launch is then confirmed before running. */
  askedAnything: boolean;
};

// @types/node declares process.stdin.isTTY / process.stdout.isTTY as `boolean`, but
// when the stream is a pipe or file the property is undefined (observed under Bun 1.4.2).
// Reading it through this parameter type keeps the undefined case visible to the
// compiler and to the type-aware linter.
type PossiblyTerminalStream = { isTTY?: boolean };

function isTerminal(stream: PossiblyTerminalStream): boolean {
  return stream.isTTY === true;
}

function formatUsage(): string {
  return [
    "Usage:",
    "  daw                                    pick everything interactively",
    `  daw ${LIST_COMMAND}                               teams, entry points, parameters, efforts`,
    "  daw <team> [<entrypoint>] [options] [--<parameter> <value>]... [-- <docker agent run flags>]",
    "",
    "Options:",
    "  --project <path>   checkout to work on (default: the current directory's git repository)",
    "  --base <ref>       branch a new worktree from this ref (default: the remote default branch)",
    "  --effort <flavor>  one of the team's flavors in team.yaml (default: the team's defaults)",
    "  --print            print the command instead of running it",
    "  --help, -h         this help",
    "",
    "Examples:",
    "  daw issue-team work-issue --issue 123 --effort low",
    "  daw issue-team pr-followup --pr 456 --project ~/code/app -- --safety balanced",
  ].join("\n");
}

function describeEntryPointParameters(entryPoint: EntryPointDefinition): string {
  return Object.entries(entryPoint.parameters)
    .map(([parameterName, parameter]) => `--${parameterName} <${parameter.type}>`)
    .join(" ");
}

function formatTeamList(teams: WorkflowManifest[]): string {
  const sections = teams.map((team) => {
    const { flavorNames } = readTeamConfigSummary(team.teamConfigPath);
    const efforts = flavorNames.length === 0 ? "none (team defaults only)" : flavorNames.join(", ");
    const entryPointLines = Object.entries(team.entrypoints).map(
      ([entryPointName, entryPoint]) =>
        `  ${entryPointName} ${describeEntryPointParameters(entryPoint)}\n      ${entryPoint.description}`,
    );
    return [`${team.name} — ${team.description}`, ...entryPointLines, `  efforts: ${efforts}`].join(
      "\n",
    );
  });
  return sections.join("\n\n");
}

async function chooseTeam(
  teams: WorkflowManifest[],
  requestedTeamName: string | undefined,
  interaction: Interaction,
): Promise<WorkflowManifest> {
  if (requestedTeamName !== undefined) {
    const team = teams.find((candidate) => candidate.name === requestedTeamName);
    if (team === undefined) {
      const teamNames = teams.map((candidate) => candidate.name).join(", ");
      throw new UsageError(`no team named '${requestedTeamName}'; teams: ${teamNames}`);
    }
    return team;
  }
  if (!interaction.canPrompt) {
    throw new UsageError("name a team, or run daw in a terminal to pick one");
  }
  interaction.askedAnything = true;
  const chosenName = await askToChoose(
    "Team",
    teams.map((team) => ({ value: team.name, label: team.name, hint: team.description })),
  );
  const chosenTeam = teams.find((team) => team.name === chosenName);
  if (chosenTeam === undefined) {
    throw new Error(`picked team '${chosenName}' vanished from the list`);
  }
  return chosenTeam;
}

async function chooseEntryPointName(
  team: WorkflowManifest,
  requestedEntryPointName: string | undefined,
  interaction: Interaction,
): Promise<string> {
  const entryPointNames = Object.keys(team.entrypoints);
  if (requestedEntryPointName !== undefined) {
    if (!entryPointNames.includes(requestedEntryPointName)) {
      throw new UsageError(
        `team '${team.name}' has no entry point '${requestedEntryPointName}'; entry points: ${entryPointNames.join(", ")}`,
      );
    }
    return requestedEntryPointName;
  }
  if (!interaction.canPrompt) {
    throw new UsageError(`name an entry point of '${team.name}': ${entryPointNames.join(", ")}`);
  }
  interaction.askedAnything = true;
  return askToChoose(
    "Entry point",
    Object.entries(team.entrypoints).map(([entryPointName, entryPoint]) => ({
      value: entryPointName,
      label: entryPointName,
      hint: entryPoint.description,
    })),
  );
}

function describeProjectPathProblem(projectPath: string): string | undefined {
  try {
    resolveGitToplevel(resolve(projectPath));
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function chooseProjectRoot(
  requestedProjectPath: string | undefined,
  interaction: Interaction,
): Promise<string> {
  if (requestedProjectPath !== undefined) {
    const problem = describeProjectPathProblem(requestedProjectPath);
    if (problem !== undefined) {
      throw new UsageError(problem);
    }
    return resolveGitToplevel(resolve(requestedProjectPath));
  }
  const currentDirectory = process.cwd();
  const currentDirectoryIsProject = describeProjectPathProblem(currentDirectory) === undefined;
  if (!interaction.canPrompt) {
    if (!currentDirectoryIsProject) {
      throw new UsageError(
        "the current directory is not a git repository; pass --project <path> or cd into one",
      );
    }
    return resolveGitToplevel(currentDirectory);
  }
  interaction.askedAnything = true;
  const answer = await askForText(
    "Project checkout (path to a git repository)",
    (projectPath) => describeProjectPathProblem(projectPath),
    currentDirectoryIsProject ? resolveGitToplevel(currentDirectory) : undefined,
  );
  return resolveGitToplevel(resolve(answer));
}

async function chooseEffort(
  team: WorkflowManifest,
  requestedEffort: string | undefined,
  interaction: Interaction,
): Promise<string | undefined> {
  const { flavorNames } = readTeamConfigSummary(team.teamConfigPath);
  if (requestedEffort !== undefined) {
    const problem = describeInvalidEffort(requestedEffort, flavorNames);
    if (problem !== undefined) {
      throw new UsageError(problem);
    }
    return requestedEffort;
  }
  if (!interaction.canPrompt || flavorNames.length === 0) {
    return undefined;
  }
  interaction.askedAnything = true;
  const chosenEffort = await askToChoose("Effort (docker-agent flavor)", [
    { value: TEAM_DEFAULT_EFFORT_CHOICE, label: "default", hint: "team.yaml as written" },
    ...flavorNames.map((flavorName) => ({ value: flavorName, label: flavorName })),
  ]);
  return chosenEffort === TEAM_DEFAULT_EFFORT_CHOICE ? undefined : chosenEffort;
}

async function chooseBaseRef(
  projectRoot: string,
  requestedBaseRef: string | undefined,
  interaction: Interaction,
): Promise<string> {
  if (requestedBaseRef !== undefined) {
    if (!refExists(projectRoot, requestedBaseRef)) {
      throw new UsageError(`--base '${requestedBaseRef}' is not a commit in ${projectRoot}`);
    }
    return requestedBaseRef;
  }
  const defaultBranchRef = resolveDefaultBranchRef(projectRoot);
  const remoteBranches = listRemoteBranches(projectRoot);
  if (!interaction.canPrompt || remoteBranches.length <= 1) {
    return defaultBranchRef;
  }
  interaction.askedAnything = true;
  const otherBranches = remoteBranches.filter((branchName) => branchName !== defaultBranchRef);
  return askToChoose(
    "Base branch for the new worktree (as of the last fetch)",
    [
      { value: defaultBranchRef, label: defaultBranchRef, hint: "default branch" },
      ...otherBranches.map((branchName) => ({ value: branchName, label: branchName })),
    ],
    defaultBranchRef,
  );
}

async function collectParameterValues(
  entryPoint: EntryPointDefinition,
  optionValues: Map<string, string>,
  interaction: Interaction,
): Promise<Record<string, string>> {
  const parameterValues: Record<string, string> = {};
  for (const [parameterName, parameter] of Object.entries(entryPoint.parameters)) {
    const flagValue = optionValues.get(parameterName);
    if (flagValue !== undefined) {
      const problem = describeInvalidParameterValue(parameterName, parameter, flagValue);
      if (problem !== undefined) {
        throw new UsageError(problem);
      }
      parameterValues[parameterName] = flagValue;
      continue;
    }
    if (!interaction.canPrompt) {
      throw new UsageError(`missing --${parameterName} <${parameter.type}> (${parameter.label})`);
    }
    interaction.askedAnything = true;
    parameterValues[parameterName] = await askForText(parameter.label, (value) =>
      describeInvalidParameterValue(parameterName, parameter, value),
    );
  }
  return parameterValues;
}

async function runPlan(plan: LaunchPlan): Promise<number> {
  let childProcess: Bun.Subprocess;
  try {
    childProcess = Bun.spawn(plan.commandWords, {
      cwd: plan.workingDirectory,
      env: { ...process.env, PATH: plan.pathEnvironment },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`could not start '${plan.commandWords[0]}': ${reason}`, { cause: error });
  }
  // Ctrl-C belongs to the docker-agent TUI (it cancels the current turn). The terminal
  // sends SIGINT to the whole foreground process group, so the launcher must ignore it
  // or it would exit and leave the agent running without its parent.
  process.on("SIGINT", () => {});
  return childProcess.exited;
}

async function launch(
  parsedArguments: ParsedArguments,
  teams: WorkflowManifest[],
): Promise<number> {
  const interaction: Interaction = {
    canPrompt: isTerminal(process.stdin) && isTerminal(process.stdout),
    askedAnything: false,
  };
  const [requestedTeamName, requestedEntryPointName, ...extraPositionals] =
    parsedArguments.positionals;
  if (extraPositionals.length > 0) {
    throw new UsageError(
      `unexpected arguments: ${extraPositionals.join(" ")}; parameters are flags, e.g. --issue 123`,
    );
  }

  const team = await chooseTeam(teams, requestedTeamName, interaction);
  const entryPointName = await chooseEntryPointName(team, requestedEntryPointName, interaction);
  const entryPoint = team.entrypoints[entryPointName];
  if (entryPoint === undefined) {
    throw new Error(`entry point '${entryPointName}' vanished from team '${team.name}'`);
  }

  const unknownOptionNames = findUnknownOptionNames(
    parsedArguments.optionValues,
    Object.keys(entryPoint.parameters),
  );
  if (unknownOptionNames.length > 0) {
    throw new UsageError(
      `unknown option(s) for ${team.name} ${entryPointName}: ${unknownOptionNames.map((name) => `--${name}`).join(", ")}`,
    );
  }

  const { agentNames } = readTeamConfigSummary(team.teamConfigPath);
  if (!agentNames.includes(entryPoint.agent)) {
    throw new Error(
      `${team.name} ${entryPointName} starts agent '${entryPoint.agent}', which ${team.teamConfigPath} does not define`,
    );
  }

  const projectRoot = await chooseProjectRoot(
    parsedArguments.optionValues.get("project"),
    interaction,
  );
  const requestedBaseRef = parsedArguments.optionValues.get("base");
  if (requestedBaseRef !== undefined && entryPoint.worktree.mode !== "new") {
    throw new UsageError(
      `--base only applies to entry points that create a new worktree; ${entryPointName} uses '${entryPoint.worktree.mode}'`,
    );
  }
  const baseRef =
    entryPoint.worktree.mode === "new"
      ? await chooseBaseRef(projectRoot, requestedBaseRef, interaction)
      : undefined;
  const effort = await chooseEffort(team, parsedArguments.optionValues.get("effort"), interaction);
  const parameterValues = await collectParameterValues(
    entryPoint,
    parsedArguments.optionValues,
    interaction,
  );

  let pullRequestWorktree: PullRequestWorktreeState | undefined;
  if (entryPoint.worktree.mode === "pr") {
    const pullRequestNumber = Number(parameterValues[entryPoint.worktree.pull_request_parameter]);
    pullRequestWorktree = inspectPullRequestWorktree(projectRoot, pullRequestNumber);
  }

  const plan = buildLaunchPlan({
    manifest: team,
    entryPointName,
    projectRoot,
    repositoryName: basename(projectRoot),
    parameterValues,
    effort,
    baseRef,
    pullRequestWorktree,
    passthroughArguments: parsedArguments.passthroughArguments,
    inheritedPath: process.env.PATH ?? "",
  });
  const commandLine = renderPlanAsShellCommand(plan, team.pathDirectories);

  if (parsedArguments.switches.has("print")) {
    console.log(commandLine);
    return EXIT_CODE_SUCCESS;
  }
  if (interaction.askedAnything) {
    showNote(commandLine, "About to run");
    if (!(await askToConfirm("Launch?"))) {
      throw new LaunchCancelledError();
    }
  } else {
    console.error(`daw: ${commandLine}`);
  }
  return runPlan(plan);
}

async function main(commandLineArguments: string[]): Promise<number> {
  try {
    const parsedArguments = parseArguments(commandLineArguments);
    if (parsedArguments.switches.has("help")) {
      console.log(formatUsage());
      return EXIT_CODE_SUCCESS;
    }
    const teams = discoverTeams(LAUNCHER_REPOSITORY_ROOT);
    if (teams.length === 0) {
      throw new Error(`no team manifests found under ${LAUNCHER_REPOSITORY_ROOT}`);
    }
    if (parsedArguments.positionals[0] === LIST_COMMAND) {
      console.log(formatTeamList(teams));
      return EXIT_CODE_SUCCESS;
    }
    return await launch(parsedArguments, teams);
  } catch (error) {
    if (error instanceof LaunchCancelledError) {
      console.error("daw: cancelled, nothing launched");
      return EXIT_CODE_CANCELLED;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`daw: ${message}`);
    if (error instanceof UsageError) {
      console.error("run 'daw --help' for usage");
      return EXIT_CODE_USAGE;
    }
    return EXIT_CODE_FAILURE;
  }
}

// Exported for the help-text test, which checks every launcher flag is documented.
export { formatUsage };

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
