// Turns fully resolved choices into the exact `docker agent run` command, working
// directory and PATH. Pure: no git calls, no filesystem, no prompts. Everything that
// needs the outside world is resolved by the caller first, so this is where tests
// pin down what each entry point actually executes.

import { delimiter } from "node:path";

import type { PullRequestWorktreeState } from "./git.ts";
import { BUILT_IN_REPOSITORY_PLACEHOLDER, type WorkflowManifest } from "./manifest.ts";
import { fillTemplate } from "./template.ts";

// docker-agent places the worktree at ~/.cagent/worktrees/<name>; keep names to
// characters that are safe as one path segment and as a git branch suffix.
const WORKTREE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Everything needed to build the command, already validated and resolved. */
export type LaunchRequest = {
  manifest: WorkflowManifest;
  entryPointName: string;
  /** Git toplevel of the project the team works on. */
  projectRoot: string;
  /** Value of the built-in {repo} placeholder. */
  repositoryName: string;
  /** Validated parameter values, keyed by parameter name. */
  parameterValues: Record<string, string>;
  /** A flavor name from the team's team.yaml, or undefined for the team's defaults. */
  effort: string | undefined;
  /** Ref the new worktree branches from; required when the worktree mode is `new`. */
  baseRef: string | undefined;
  /** What exists at the PR worktree path; required when the worktree mode is `pr`. */
  pullRequestWorktree: PullRequestWorktreeState | undefined;
  /** Extra `docker agent run` flags given after `--`, such as `--safety balanced`. */
  passthroughArguments: string[];
  /** PATH of the launcher process, which the team's helper directories are prepended to. */
  inheritedPath: string;
};

/** The command to execute and the environment to execute it in. */
export type LaunchPlan = {
  commandWords: string[];
  workingDirectory: string;
  /** PATH for the docker-agent process: the team's helper directories, then the inherited PATH. */
  pathEnvironment: string;
};

/**
 * Builds the docker-agent invocation for one entry point.
 * @throws Error when the request is inconsistent with the entry point's worktree mode,
 *   or the PR worktree path is held by another repository.
 */
export function buildLaunchPlan(request: LaunchRequest): LaunchPlan {
  const entryPoint = request.manifest.entrypoints[request.entryPointName];
  if (entryPoint === undefined) {
    throw new Error(
      `team '${request.manifest.name}' has no entry point '${request.entryPointName}'`,
    );
  }

  const templateValues = {
    ...request.parameterValues,
    [BUILT_IN_REPOSITORY_PLACEHOLDER]: request.repositoryName,
  };

  const commandWords = [
    "docker",
    "agent",
    "run",
    request.manifest.teamConfigPath,
    "--agent",
    entryPoint.agent,
  ];
  if (request.effort !== undefined) {
    commandWords.push("--flavor", request.effort);
  }

  const worktree = entryPoint.worktree;
  if (worktree.mode === "new") {
    if (request.baseRef === undefined) {
      throw new Error(
        `entry point '${request.entryPointName}' needs a base ref for its new worktree`,
      );
    }
    const worktreeName = fillTemplate(worktree.name, templateValues);
    if (!WORKTREE_NAME_PATTERN.test(worktreeName)) {
      throw new Error(`worktree name '${worktreeName}' must match ${WORKTREE_NAME_PATTERN}`);
    }
    commandWords.push(`--worktree=${worktreeName}`, "--worktree-base", request.baseRef);
  } else if (worktree.mode === "pr") {
    const pullRequestNumber = request.parameterValues[worktree.pull_request_parameter];
    const worktreeState = request.pullRequestWorktree;
    if (pullRequestNumber === undefined || worktreeState === undefined) {
      throw new Error(
        `entry point '${request.entryPointName}' needs a PR number and the PR worktree state`,
      );
    }
    if (worktreeState.kind === "foreign") {
      throw new Error(
        `${worktreeState.path} belongs to another repository; remove it with 'git worktree remove' from that repository first`,
      );
    }
    if (worktreeState.kind === "reusable") {
      // Continue in the kept worktree rather than asking docker-agent to create it again;
      // same behavior as the original issue-team.sh pr-followup function.
      commandWords.push("--working-dir", worktreeState.path);
    } else {
      commandWords.push("--worktree-pr", pullRequestNumber);
    }
  }

  commandWords.push(...request.passthroughArguments);
  // The message goes last: it is a positional argument after all flags.
  commandWords.push(fillTemplate(entryPoint.message, templateValues));

  const pathEntries = [...request.manifest.pathDirectories];
  if (request.inheritedPath !== "") {
    pathEntries.push(request.inheritedPath);
  }

  return {
    commandWords,
    // Start docker-agent inside the project, as issue-team.sh did by running from the
    // user's shell: --worktree and --worktree-pr act on "the working directory".
    workingDirectory: request.projectRoot,
    pathEnvironment: pathEntries.join(delimiter),
  };
}
