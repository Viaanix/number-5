#!/usr/bin/env bun
// `j5` — the universal launcher for the docker-agent teams in this repository.
// It picks a team and entry point, a project checkout, a base branch, an effort
// (a docker-agent flavor) and the entry point's parameters, from flags or by asking,
// then runs `docker agent run` with the team's helper scripts on PATH.
//
// Every value can come from a flag; anything missing is asked for when stdin and
// stdout are a terminal, and is an error otherwise. `--print` shows the exact
// command instead of running it.
//
// An entry point with a `queue:` block can also run over a queue (`--queue 1,2,3` or
// `--queue-label <label>`): once per value, one after another, unattended. run.ts
// executes it; queue.ts reads each item's outcome.

import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { findUnknownOptionNames, type ParsedArguments, parseArguments } from "./arguments.ts";
import { formatBanner } from "./banner.ts";
import { readPathValue } from "./environment.ts";
import { EFFORT_FLAVOR_PREFIX, MODEL_FLAVOR_PREFIX } from "./flavor-catalog.ts";
import {
  inspectWorktreePath,
  listOpenIssuesWithLabel,
  listRemoteBranches,
  localBranchExists,
  refExists,
  resolveDefaultBranchRef,
  resolveGitToplevel,
  resolvePullRequestBranch,
} from "./git.ts";
import type { EntryPointDefinition, WorkflowManifest } from "./manifest.ts";
import { readPackageInfo } from "./package-info.ts";
import { describeInvalidChoice, describeInvalidParameterValue } from "./parameters.ts";
import {
  buildLaunchPlan,
  type LaunchPlan,
  type QueueItemContext,
  resolveWorktreeLocation,
  type WorktreeFacts,
} from "./plan.ts";
import {
  askForText,
  askToChoose,
  askToConfirm,
  LaunchCancelledError,
  showBanner,
  showNote,
} from "./prompts.ts";
import { checkProxyImage, describeDifferentProxyImage } from "./proxy-image.ts";
import {
  DEFAULT_ROUND_LIMIT,
  describeRoundLimit,
  parseQueueValues,
  parseRoundLimit,
  type RoundLimit,
} from "./queue.ts";
import { chooseAutomaticFlavors } from "./reviewer-flavor.ts";
import { runPlan, runQueue } from "./run.ts";
import { createSetupEnvironment, runCapturedCommand, runSetup } from "./setup.ts";
import { renderPlanAsShellCommand, shellDialectForPlatform } from "./shell-quote.ts";
import { readTeamConfigSummary } from "./team-config.ts";
import { createDockerAgentRunner } from "./team-models.ts";
import { discoverTeams, resolveTeamsDirectory } from "./teams.ts";

// This file lives at <root>/launcher/src/cli.ts; teams live under <root>/workflows/. <root> is the
// clone when run from a checkout and the installed package directory otherwise, which is why only
// paths relative to this file are used to find teams, skills and the proxy files.
const LAUNCHER_REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..");

const EXIT_CODE_SUCCESS = 0;
const EXIT_CODE_FAILURE = 1;
const EXIT_CODE_USAGE = 2;
// Conventional exit status for "interrupted by Ctrl-C" (128 + SIGINT).
const EXIT_CODE_CANCELLED = 130;

const LIST_COMMAND = "list";
const SETUP_COMMAND = "setup";
// Switches that only mean something to `j5 setup`; anywhere else they are a usage error.
const SETUP_ONLY_SWITCH_NAMES = ["check", "proxy", "login"] as const;

// Value of a model or effort choice that passes no --flavor. Empty because a tier or level name
// never is.
const TEAM_DEFAULT_CHOICE = "";

// Queue runs: their logs and summary go under <project>/.j5/queue/<start time>/, the
// same .j5/ directory test-quality's audit reports use.
const QUEUE_LOG_DIRECTORY_PARTS = [".j5", "queue"];
// docker-agent's flag for a run without the TUI; every queue item is unattended.
const UNATTENDED_FLAG = "--exec";
const QUEUE_SOURCE_SINGLE = "single";
const QUEUE_SOURCE_VALUES = "values";
const QUEUE_SOURCE_LABEL = "label";

/** A mistake in how j5 was called; reported with a pointer to --help. */
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

// Johnny 5 flavor lines (Short Circuit, 1986), added on top of the real output and
// never instead of it: the help, list and prompts must still read plainly without them.
const LIST_HEADER = "Input! Input!";
const INTERACTIVE_BANNER = "Need input!";
const PARAMETER_PROMPT_PREFIX = "Need input:";

function formatUsage(): string {
  return [
    formatBanner(),
    "",
    "Usage:",
    "  j5                                    pick everything interactively",
    `  j5 ${LIST_COMMAND}                               teams, entry points, parameters, models, efforts`,
    `  j5 ${SETUP_COMMAND} [--check] [--proxy] [--login]     check this machine, install the skills, optionally start the proxy`,
    "  j5 <team> [<entrypoint>] [options] [--<parameter> <value>]... [-- <docker agent run flags>]",
    "",
    "Options:",
    "  --project <path>   checkout to work on (default: the current directory's git repository)",
    "  --base <ref>       branch a new worktree from this ref (default: the remote default branch)",
    "  --model <tier>     model tier for the team's builders: haiku, sonnet or opus, as the team offers (default: team.yaml as written)",
    "  --effort <level>   reasoning effort: low, medium, high or xhigh, as the team offers (default: team.yaml as written)",
    "  --queue <n,n,...>  run the entry point once per value, unattended (entry points with a queue)",
    "  --queue-label <l>  the same, over every open issue with this label (needs gh access to the repo)",
    "  --max-rounds <n>   fix rounds per queue item, or 'none' for no limit (default 5)",
    "  --print            print the command instead of running it",
    "  --version          the installed version",
    "  --help, -h         this help",
    "",
    "Setup options (j5 setup only):",
    "  --check            report what is missing or out of date; change nothing",
    "  --proxy            also create the proxy token if needed and start the proxy (Docker)",
    "  --login            also open Pi to log the proxy in to your own Claude account (implies --proxy)",
    "",
    "Examples:",
    "  j5 issue-team work-issue --issue 123 --model haiku --effort medium",
    "  j5 pr-reviewer review --pr 456 --project ~/code/app -- --safety balanced",
    "  j5 issue-team work-issue --queue 474,480 --max-rounds 5",
  ].join("\n");
}

function describeEntryPointParameters(entryPoint: EntryPointDefinition): string {
  return Object.entries(entryPoint.parameters)
    .map(([parameterName, parameter]) => `--${parameterName} <${parameter.type}>`)
    .join(" ");
}

function describeOffer(offered: string[]): string {
  return offered.length === 0 ? "none (team.yaml as written only)" : offered.join(", ");
}

function formatTeamList(teams: WorkflowManifest[]): string {
  const sections = teams.map((team) => {
    const { modelTiers, effortLevels } = readTeamConfigSummary(team.teamConfigPath);
    const entryPointLines = Object.entries(team.entrypoints).map(([entryPointName, entryPoint]) => {
      // An entry point without parameters gets no separator, so no trailing space.
      const usage = [entryPointName, describeEntryPointParameters(entryPoint)]
        .filter((part) => part !== "")
        .join(" ");
      return `  ${usage}\n      ${entryPoint.description}`;
    });
    return [
      `${team.name} — ${team.description}`,
      ...entryPointLines,
      `  models: ${describeOffer(modelTiers)}`,
      `  efforts: ${describeOffer(effortLevels)}`,
    ].join("\n");
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
    throw new UsageError("name a team, or run j5 in a terminal to pick one");
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
  // Run from inside a checkout (any subdirectory), the project is that repository and
  // nobody is asked. The resolved path still shows in the `cd ...` of the command the
  // launcher prints or confirms, so a wrong guess is visible before anything runs.
  const currentDirectory = process.cwd();
  if (describeProjectPathProblem(currentDirectory) === undefined) {
    return resolveGitToplevel(currentDirectory);
  }
  if (!interaction.canPrompt) {
    throw new UsageError(
      "the current directory is not a git repository; pass --project <path> or cd into one",
    );
  }
  interaction.askedAnything = true;
  const answer = await askForText("Project checkout (path to a git repository)", (projectPath) =>
    describeProjectPathProblem(projectPath),
  );
  return resolveGitToplevel(resolve(answer));
}

// One of the two launch options that pick a standard flavor (`--model` -> `model-<tier>`,
// `--effort` -> `effort-<level>`). Returns the flavor name, or undefined for team.yaml as written.
async function chooseTuningFlavor(
  optionName: "model" | "effort",
  flavorPrefix: string,
  offeredValues: string[],
  requestedValue: string | undefined,
  interaction: Interaction,
): Promise<string | undefined> {
  if (requestedValue !== undefined) {
    const problem = describeInvalidChoice(optionName, requestedValue, offeredValues);
    if (problem !== undefined) {
      throw new UsageError(problem);
    }
    return `${flavorPrefix}${requestedValue}`;
  }
  if (!interaction.canPrompt || offeredValues.length === 0) {
    return undefined;
  }
  interaction.askedAnything = true;
  const chosenValue = await askToChoose(
    optionName === "model" ? "Model tier (docker-agent flavor)" : "Effort (docker-agent flavor)",
    [
      { value: TEAM_DEFAULT_CHOICE, label: "default", hint: "team.yaml as written" },
      ...offeredValues.map((offeredValue) => ({ value: offeredValue, label: offeredValue })),
    ],
  );
  return chosenValue === TEAM_DEFAULT_CHOICE ? undefined : `${flavorPrefix}${chosenValue}`;
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
  queueParameterName: string | undefined,
): Promise<Record<string, string>> {
  const parameterValues: Record<string, string> = {};
  for (const [parameterName, parameter] of Object.entries(entryPoint.parameters)) {
    // In a queue run the queue supplies this parameter, one value per item.
    if (parameterName === queueParameterName) {
      continue;
    }
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
    parameterValues[parameterName] = await askForText(
      `${PARAMETER_PROMPT_PREFIX} ${parameter.label}`,
      (value) => describeInvalidParameterValue(parameterName, parameter, value),
    );
  }
  return parameterValues;
}

/** Where a queue's values come from, before the project is known. */
type QueueSource = { kind: "values"; values: string[] } | { kind: "label"; label: string };

/** A queue run's choices; undefined from chooseQueue means a single run. */
type QueueChoice = { parameterName: string; source: QueueSource; roundLimit: RoundLimit };

/**
 * Decides between a single run and a queue run, from --queue / --queue-label /
 * --max-rounds or, in a terminal, by asking. Only entry points with a `queue:` block
 * can run as a queue.
 */
async function chooseQueue(
  entryPointName: string,
  entryPoint: EntryPointDefinition,
  optionValues: Map<string, string>,
  interaction: Interaction,
): Promise<QueueChoice | undefined> {
  const requestedValues = optionValues.get("queue");
  const requestedLabel = optionValues.get("queue-label");
  const requestedRoundLimit = optionValues.get("max-rounds");
  const queue = entryPoint.queue;
  if (queue === undefined) {
    if (
      requestedValues !== undefined ||
      requestedLabel !== undefined ||
      requestedRoundLimit !== undefined
    ) {
      throw new UsageError(
        `--queue, --queue-label and --max-rounds only apply to entry points with a queue; ${entryPointName} has none`,
      );
    }
    return undefined;
  }
  if (requestedValues !== undefined && requestedLabel !== undefined) {
    throw new UsageError("--queue and --queue-label are alternatives; give one");
  }
  const singleValueGiven = optionValues.has(queue.parameter);
  if (singleValueGiven && (requestedValues !== undefined || requestedLabel !== undefined)) {
    throw new UsageError(
      `--${queue.parameter} runs one item; --queue / --queue-label run several; give one`,
    );
  }

  let source: QueueSource | undefined;
  if (requestedValues !== undefined) {
    const parsed = parseQueueValues("queue", requestedValues);
    if ("problem" in parsed) {
      throw new UsageError(parsed.problem);
    }
    source = { kind: "values", values: parsed.values };
  } else if (requestedLabel !== undefined) {
    source = { kind: "label", label: requestedLabel };
  } else if (!singleValueGiven && interaction.canPrompt) {
    interaction.askedAnything = true;
    const sourceKind = await askToChoose(`Run ${entryPointName} on`, [
      { value: QUEUE_SOURCE_SINGLE, label: `one ${queue.parameter}` },
      {
        value: QUEUE_SOURCE_VALUES,
        label: `a queue of ${queue.parameter} numbers`,
        hint: "unattended",
      },
      {
        value: QUEUE_SOURCE_LABEL,
        label: `every open issue with a label`,
        hint: "unattended; needs gh access",
      },
    ]);
    if (sourceKind === QUEUE_SOURCE_VALUES) {
      const answer = await askForText(
        `${PARAMETER_PROMPT_PREFIX} ${queue.parameter} numbers, comma-separated`,
        (value) => {
          const parsed = parseQueueValues("queue", value);
          return "problem" in parsed ? parsed.problem : undefined;
        },
      );
      const parsed = parseQueueValues("queue", answer);
      if ("problem" in parsed) {
        throw new UsageError(parsed.problem);
      }
      source = { kind: "values", values: parsed.values };
    } else if (sourceKind === QUEUE_SOURCE_LABEL) {
      const label = await askForText(`${PARAMETER_PROMPT_PREFIX} label`, (value) =>
        value.trim() === "" ? "a label is needed" : undefined,
      );
      source = { kind: "label", label: label.trim() };
    }
  }
  if (source === undefined) {
    if (requestedRoundLimit !== undefined) {
      throw new UsageError("--max-rounds only applies with --queue or --queue-label");
    }
    return undefined;
  }

  let roundLimit = DEFAULT_ROUND_LIMIT;
  if (requestedRoundLimit !== undefined) {
    const parsedRoundLimit = parseRoundLimit(requestedRoundLimit);
    if ("problem" in parsedRoundLimit) {
      throw new UsageError(parsedRoundLimit.problem);
    }
    roundLimit = parsedRoundLimit.limit;
  }
  return { parameterName: queue.parameter, source, roundLimit };
}

/** Looks up what exists where the entry point's worktree goes, for buildLaunchPlan. */
function resolveWorktreeFacts(
  team: WorkflowManifest,
  entryPointName: string,
  entryPoint: EntryPointDefinition,
  projectRoot: string,
  repositoryName: string,
  parameterValues: Record<string, string>,
): WorktreeFacts | undefined {
  const worktreeLocation = resolveWorktreeLocation(
    team,
    entryPointName,
    projectRoot,
    repositoryName,
    parameterValues,
  );
  if (worktreeLocation === undefined) {
    return undefined;
  }
  const state = inspectWorktreePath(projectRoot, worktreeLocation.path);
  let pullRequestBranch: WorktreeFacts["pullRequestBranch"];
  if (entryPoint.worktree.mode === "pr" && state.kind === "absent") {
    // Read-only, over git's own transport (SSH for an SSH origin): no gh login needed.
    const branchName = resolvePullRequestBranch(
      projectRoot,
      Number(parameterValues[entryPoint.worktree.pull_request_parameter]),
    );
    pullRequestBranch = {
      name: branchName,
      existsLocally: localBranchExists(projectRoot, branchName),
    };
  }
  return { state, pullRequestBranch };
}

// A directory name from the start time, without the colons Windows forbids in paths.
function formatQueueStartTime(startTime: Date): string {
  return startTime
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replaceAll(":", "-");
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

  if (interaction.canPrompt && requestedTeamName === undefined) {
    console.log(`${formatBanner()}\n`);
    showBanner(INTERACTIVE_BANNER);
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
  const { modelTiers, effortLevels } = readTeamConfigSummary(team.teamConfigPath);
  const modelFlavor = await chooseTuningFlavor(
    "model",
    MODEL_FLAVOR_PREFIX,
    modelTiers,
    parsedArguments.optionValues.get("model"),
    interaction,
  );
  const effortFlavor = await chooseTuningFlavor(
    "effort",
    EFFORT_FLAVOR_PREFIX,
    effortLevels,
    parsedArguments.optionValues.get("effort"),
    interaction,
  );
  // Model before effort, which is arbitrary (they patch different keys); the reviewer's flavor,
  // chosen next, must come after both so it sees the models they set.
  const userFlavors = [modelFlavor, effortFlavor].filter(
    (flavorName): flavorName is string => flavorName !== undefined,
  );
  // For a team that keeps its reviewer independent of its builders, choose the reviewer's model
  // tier now, from the models those flavors set, and stop before any worktree exists if it cannot
  // be done. docker-agent is asked for the real, merged models; see launcher/src/reviewer-flavor.ts.
  const automaticFlavors = chooseAutomaticFlavors(
    team,
    userFlavors,
    parsedArguments.passthroughArguments,
    createDockerAgentRunner(team.directory),
  );
  if (automaticFlavors.explanation !== undefined) {
    console.error(`j5: ${automaticFlavors.explanation}`);
  }
  // Advisory, and only for a real launch: --print must stay instant and free of side effects.
  if (!parsedArguments.switches.has("print")) {
    const proxyImage = checkProxyImage(LAUNCHER_REPOSITORY_ROOT, runCapturedCommand);
    if (proxyImage.kind === "different") {
      console.error(`j5: warning: ${describeDifferentProxyImage(proxyImage)}`);
    }
  }
  const queueChoice = await chooseQueue(
    entryPointName,
    entryPoint,
    parsedArguments.optionValues,
    interaction,
  );
  const parameterValues = await collectParameterValues(
    entryPoint,
    parsedArguments.optionValues,
    interaction,
    queueChoice?.parameterName,
  );

  const repositoryName = basename(projectRoot);
  const buildPlan = (
    values: Record<string, string>,
    queueItem: QueueItemContext | undefined,
    passthroughArguments: string[],
  ): LaunchPlan =>
    buildLaunchPlan({
      manifest: team,
      entryPointName,
      projectRoot,
      repositoryName,
      parameterValues: values,
      flavorNames: [...userFlavors, ...automaticFlavors.flavorNames],
      baseRef,
      worktree: resolveWorktreeFacts(
        team,
        entryPointName,
        entryPoint,
        projectRoot,
        repositoryName,
        values,
      ),
      queueItem,
      passthroughArguments,
      inheritedPath: readPathValue(process.env),
    });
  const renderCommandLine = (plan: LaunchPlan): string =>
    renderPlanAsShellCommand(plan, team.pathDirectories, shellDialectForPlatform(process.platform));

  if (queueChoice !== undefined) {
    const queueValues =
      queueChoice.source.kind === "values"
        ? queueChoice.source.values
        : listOpenIssuesWithLabel(projectRoot, queueChoice.source.label);
    if (queueValues.length === 0 && queueChoice.source.kind === "label") {
      throw new UsageError(`no open issues have the label '${queueChoice.source.label}'`);
    }
    const unattendedPassthrough = parsedArguments.passthroughArguments.includes(UNATTENDED_FLAG)
      ? parsedArguments.passthroughArguments
      : [...parsedArguments.passthroughArguments, UNATTENDED_FLAG];
    const roundLimitText = describeRoundLimit(queueChoice.roundLimit);
    const queueItems = queueValues.map((value, index) => ({
      value,
      plan: buildPlan(
        { ...parameterValues, [queueChoice.parameterName]: value },
        { position: index + 1, count: queueValues.length, roundLimitText },
        unattendedPassthrough,
      ),
    }));
    if (parsedArguments.switches.has("print")) {
      console.log(queueItems.map((item) => renderCommandLine(item.plan)).join("\n"));
      return EXIT_CODE_SUCCESS;
    }
    const queueDescription = `${team.name} ${entryPointName}, unattended, ${queueChoice.parameterName} ${queueValues.join(", ")}; ${roundLimitText}`;
    if (interaction.askedAnything) {
      showNote(queueDescription, "About to run a queue");
      if (!(await askToConfirm("Launch?"))) {
        throw new LaunchCancelledError();
      }
    } else {
      console.error(`j5: queue: ${queueDescription}`);
    }
    return runQueue(
      queueItems,
      join(projectRoot, ...QUEUE_LOG_DIRECTORY_PARTS, formatQueueStartTime(new Date())),
      queueChoice.parameterName,
      `j5 queue: ${queueDescription}`,
    );
  }

  const plan = buildPlan(parameterValues, undefined, parsedArguments.passthroughArguments);
  const commandLine = renderCommandLine(plan);

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
    console.error(`j5: ${commandLine}`);
  }
  return runPlan(plan);
}

/** `j5 setup`: validates the arguments, then checks the machine and installs what j5 needs. */
async function setUp(parsedArguments: ParsedArguments): Promise<number> {
  const hasOtherArguments =
    parsedArguments.positionals.length > 1 ||
    parsedArguments.optionValues.size > 0 ||
    parsedArguments.passthroughArguments.length > 0;
  if (hasOtherArguments) {
    throw new UsageError(`j5 ${SETUP_COMMAND} takes only --check, --proxy and --login`);
  }
  if (parsedArguments.switches.has("print")) {
    throw new UsageError(
      `--print does not apply to j5 ${SETUP_COMMAND}; use --check to report without changing anything`,
    );
  }
  const withLogin = parsedArguments.switches.has("login");
  const checkOnly = parsedArguments.switches.has("check");
  if (checkOnly && withLogin) {
    throw new UsageError("--login changes things, so it cannot be combined with --check");
  }
  const packageInfo = readPackageInfo(LAUNCHER_REPOSITORY_ROOT);
  console.log(`${packageInfo.name} ${packageInfo.version} (${LAUNCHER_REPOSITORY_ROOT})`);
  return runSetup(
    { checkOnly, withProxy: withLogin || parsedArguments.switches.has("proxy"), withLogin },
    createSetupEnvironment(LAUNCHER_REPOSITORY_ROOT, homedir()),
    (line) => console.log(line),
  );
}

async function main(commandLineArguments: string[]): Promise<number> {
  try {
    const parsedArguments = parseArguments(commandLineArguments);
    if (parsedArguments.switches.has("help")) {
      console.log(formatUsage());
      return EXIT_CODE_SUCCESS;
    }
    if (parsedArguments.switches.has("version")) {
      const packageInfo = readPackageInfo(LAUNCHER_REPOSITORY_ROOT);
      console.log(`${packageInfo.name} ${packageInfo.version}`);
      return EXIT_CODE_SUCCESS;
    }
    if (parsedArguments.positionals[0] === SETUP_COMMAND) {
      return await setUp(parsedArguments);
    }
    const misplacedSetupSwitches = SETUP_ONLY_SWITCH_NAMES.filter((switchName) =>
      parsedArguments.switches.has(switchName),
    );
    if (misplacedSetupSwitches.length > 0) {
      throw new UsageError(
        `--${misplacedSetupSwitches.join(", --")} only applies to 'j5 ${SETUP_COMMAND}'`,
      );
    }
    const teams = discoverTeams(LAUNCHER_REPOSITORY_ROOT);
    if (teams.length === 0) {
      throw new Error(
        `no team manifests found under ${resolveTeamsDirectory(LAUNCHER_REPOSITORY_ROOT)}`,
      );
    }
    if (parsedArguments.positionals[0] === LIST_COMMAND) {
      console.log(`${LIST_HEADER}\n\n${formatTeamList(teams)}`);
      return EXIT_CODE_SUCCESS;
    }
    return await launch(parsedArguments, teams);
  } catch (error) {
    if (error instanceof LaunchCancelledError) {
      console.error("j5: cancelled, nothing launched");
      return EXIT_CODE_CANCELLED;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`j5: ${message}`);
    if (error instanceof UsageError) {
      console.error("run 'j5 --help' for usage");
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
