// Turns fully resolved choices into the exact commands j5 runs: the git steps that
// prepare a worktree, then `docker agent run`, with its working directory and PATH.
// Pure: no git calls, no filesystem, no prompts. Everything that needs the outside
// world is resolved by the caller first, so this is where tests pin down what each
// entry point actually executes.
//
// j5 creates worktrees itself, next to the project, and starts docker-agent inside
// them with --working-dir. docker-agent's own --worktree / --worktree-pr create the
// worktree but leave a Claude Code harness agent running in the user's checkout
// (docs/docker-agent/gotchas.md), so they are not used.

import { delimiter, dirname, join } from "node:path";

import { ORIGIN_REMOTE_NAME, type WorktreeState } from "./git.ts";
import {
  BUILT_IN_REPOSITORY_PLACEHOLDER,
  type EntryPointDefinition,
  QUEUE_PLACEHOLDERS,
  type WorkflowManifest,
} from "./manifest.ts";
import { fillTemplate } from "./template.ts";

// Worktree names become a directory next to the project and part of a branch name;
// keep them to characters that are safe as one path segment and in a branch name.
const WORKTREE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Branch a `new` worktree gets: the prefix docker-agent used for --worktree. Kept so
// branches users already have from that era still match.
const NEW_WORKTREE_BRANCH_PREFIX = "worktree-";

const REMOTE_TRACKING_PREFIX = `${ORIGIN_REMOTE_NAME}/`;

/** Where an entry point's worktree lives: its name and its absolute path. */
export type WorktreeLocation = { name: string; path: string };

/** What the caller found out about the worktree; required for `new` and `pr` entry points. */
export type WorktreeFacts = {
  state: WorktreeState;
  /**
   * For `pr` entry points whose worktree is absent: the PR's branch in origin, and
   * whether a local branch exists (used only for an editable worktree).
   */
  pullRequestBranch: { name: string; existsLocally: boolean } | undefined;
};

/** Where an item stands in a queue run, for the entry point's queue preamble. */
export type QueueItemContext = {
  /** 1-based place of this item in the queue. */
  position: number;
  count: number;
  /** The fix-round limit in words, e.g. "at most 3 fix rounds". */
  roundLimitText: string;
};

// Between the queue preamble and the entry point's own message.
const PREAMBLE_SEPARATOR = "\n\n";

/** Everything needed to build the commands, already validated and resolved. */
export type LaunchRequest = {
  manifest: WorkflowManifest;
  entryPointName: string;
  /** Git toplevel of the project the team works on. */
  projectRoot: string;
  /** Value of the built-in {repo} placeholder. */
  repositoryName: string;
  /** Validated parameter values, keyed by parameter name. */
  parameterValues: Record<string, string>;
  /**
   * The flavors to enable, in the order docker-agent applies them: the user's `--model` and
   * `--effort` flavors first, then the ones j5 chose itself (the reviewer's tier,
   * launcher/src/reviewer-flavor.ts), which must see the models the user's flavors set.
   */
  flavorNames: string[];
  /** Ref a new worktree branches from; required when the worktree mode is `new`. */
  baseRef: string | undefined;
  /** What exists at the worktree path; required when the worktree mode is `new` or `pr`. */
  worktree: WorktreeFacts | undefined;
  /** Set for one item of a queue run: its message starts with the entry point's queue preamble. */
  queueItem: QueueItemContext | undefined;
  /** Extra `docker agent run` flags given after `--`, such as `--safety balanced`. */
  passthroughArguments: string[];
  /** PATH of the launcher process, which the team's helper directories are prepended to. */
  inheritedPath: string;
};

/** The commands to execute and the environment to execute docker-agent in. */
export type LaunchPlan = {
  /** Git commands that create the worktree, run in order before docker-agent; empty when it exists. */
  preparationSteps: string[][];
  commandWords: string[];
  workingDirectory: string;
  /** PATH for the docker-agent process: the team's helper directories, then the inherited PATH. */
  pathEnvironment: string;
};

function findEntryPoint(manifest: WorkflowManifest, entryPointName: string): EntryPointDefinition {
  const entryPoint = manifest.entrypoints[entryPointName];
  if (entryPoint === undefined) {
    throw new Error(`team '${manifest.name}' has no entry point '${entryPointName}'`);
  }
  return entryPoint;
}

/**
 * Returns where an entry point's worktree goes: a directory beside the project,
 * named from the manifest's template (`new`) or `<repo>-pr-<number>[-detached]` (`pr`).
 * Undefined for `none` entry points, which run in the project itself.
 * @throws Error when the name is not one safe path segment, or would be the project itself.
 */
export function resolveWorktreeLocation(
  manifest: WorkflowManifest,
  entryPointName: string,
  projectRoot: string,
  repositoryName: string,
  parameterValues: Record<string, string>,
): WorktreeLocation | undefined {
  const worktree = findEntryPoint(manifest, entryPointName).worktree;
  let worktreeName: string;
  if (worktree.mode === "new") {
    worktreeName = fillTemplate(worktree.name, {
      ...parameterValues,
      [BUILT_IN_REPOSITORY_PLACEHOLDER]: repositoryName,
    });
  } else if (worktree.mode === "pr") {
    const pullRequestNumber = parameterValues[worktree.pull_request_parameter];
    if (pullRequestNumber === undefined) {
      throw new Error(`entry point '${entryPointName}' needs a PR number`);
    }
    // Review snapshots must not be reused as editable PR follow-up worktrees.
    worktreeName = `${repositoryName}-pr-${pullRequestNumber}${worktree.detached === true ? "-detached" : ""}`;
  } else {
    return undefined;
  }
  if (!WORKTREE_NAME_PATTERN.test(worktreeName)) {
    throw new Error(`worktree name '${worktreeName}' must match ${WORKTREE_NAME_PATTERN}`);
  }
  const worktreePath = join(dirname(projectRoot), worktreeName);
  if (worktreePath === projectRoot) {
    throw new Error(`worktree name '${worktreeName}' is the project's own directory name`);
  }
  return { name: worktreeName, path: worktreePath };
}

// The git commands that create a missing worktree. `git -C <project>` makes each step
// independent of the directory it is run from, in the launcher and in --print output.
function buildPreparationSteps(
  request: LaunchRequest,
  entryPoint: EntryPointDefinition,
  location: WorktreeLocation,
): string[][] {
  const gitInProject = ["git", "-C", request.projectRoot];
  if (entryPoint.worktree.mode === "new") {
    const baseRef = request.baseRef;
    if (baseRef === undefined) {
      throw new Error(
        `entry point '${request.entryPointName}' needs a base ref for its new worktree`,
      );
    }
    const steps: string[][] = [];
    // A remote-tracking base is fetched first, so the worktree starts from the remote's
    // latest commit rather than the last fetch (docker-agent's --worktree did the same).
    if (baseRef.startsWith(REMOTE_TRACKING_PREFIX)) {
      steps.push([
        ...gitInProject,
        "fetch",
        ORIGIN_REMOTE_NAME,
        baseRef.slice(REMOTE_TRACKING_PREFIX.length),
      ]);
    }
    steps.push([
      ...gitInProject,
      "worktree",
      "add",
      "-b",
      `${NEW_WORKTREE_BRANCH_PREFIX}${location.name}`,
      location.path,
      baseRef,
    ]);
    return steps;
  }

  const pullRequestBranch = request.worktree?.pullRequestBranch;
  if (pullRequestBranch === undefined) {
    throw new Error(
      `entry point '${request.entryPointName}' needs the PR's branch to create its worktree`,
    );
  }
  const fetchStep = [...gitInProject, "fetch", ORIGIN_REMOTE_NAME, pullRequestBranch.name];
  if (entryPoint.worktree.mode === "pr" && entryPoint.worktree.detached === true) {
    // Use the freshly fetched head, not a local branch that may be occupied or stale.
    return [
      fetchStep,
      [...gitInProject, "worktree", "add", "--detach", location.path, "FETCH_HEAD"],
    ];
  }
  // A new local branch tracks the PR's branch, so `git pull --ff-only` and `git push`
  // inside the worktree update the PR. An existing local branch is used as it is.
  const addStep = pullRequestBranch.existsLocally
    ? [...gitInProject, "worktree", "add", location.path, pullRequestBranch.name]
    : [
        ...gitInProject,
        "worktree",
        "add",
        "--track",
        "-b",
        pullRequestBranch.name,
        location.path,
        `${REMOTE_TRACKING_PREFIX}${pullRequestBranch.name}`,
      ];
  return [fetchStep, addStep];
}

// A kept detached review snapshot is moved to the PR's current head. A snapshot exists to be the
// PR's head, so reusing it as it was left made a PR that gained a commit fail its next review
// ("checkout HEAD is stale") until someone deleted the directory. FETCH_HEAD is per worktree, so
// the fetch runs inside the worktree, where the checkout reads it.
function buildSnapshotRefreshSteps(request: LaunchRequest, location: WorktreeLocation): string[][] {
  const pullRequestBranch = request.worktree?.pullRequestBranch;
  if (pullRequestBranch === undefined) {
    throw new Error(
      `entry point '${request.entryPointName}' needs the PR's branch to refresh its review worktree`,
    );
  }
  const gitInWorktree = ["git", "-C", location.path];
  return [
    [...gitInWorktree, "fetch", ORIGIN_REMOTE_NAME, pullRequestBranch.name],
    [...gitInWorktree, "checkout", "--detach", "FETCH_HEAD"],
  ];
}

/**
 * Builds the worktree preparation steps and the docker-agent invocation for one entry point.
 * @throws Error when the request is inconsistent with the entry point's worktree mode,
 *   or the worktree path holds something other than a worktree of this project.
 */
export function buildLaunchPlan(request: LaunchRequest): LaunchPlan {
  const entryPoint = findEntryPoint(request.manifest, request.entryPointName);
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
  for (const flavorName of request.flavorNames) {
    commandWords.push("--flavor", flavorName);
  }

  let preparationSteps: string[][] = [];
  // `none` entry points run in the project itself.
  let workingDirectory = request.projectRoot;
  const location = resolveWorktreeLocation(
    request.manifest,
    request.entryPointName,
    request.projectRoot,
    request.repositoryName,
    request.parameterValues,
  );
  if (location !== undefined) {
    const worktreeState = request.worktree?.state;
    if (worktreeState === undefined) {
      throw new Error(
        `entry point '${request.entryPointName}' needs the state of ${location.path}`,
      );
    }
    if (worktreeState.kind === "foreign") {
      throw new Error(
        `${location.path} exists and is not a worktree of ${request.projectRoot}; move or remove it first`,
      );
    }
    if (worktreeState.kind === "absent") {
      preparationSteps = buildPreparationSteps(request, entryPoint, location);
    } else if (
      worktreeState.kind === "reusable" &&
      entryPoint.worktree.mode === "pr" &&
      entryPoint.worktree.detached === true
    ) {
      preparationSteps = buildSnapshotRefreshSteps(request, location);
    }
    // Any other reusable worktree is continued as it is: no fetch, no reset.
    workingDirectory = location.path;
    commandWords.push("--working-dir", location.path);
  }

  commandWords.push(...request.passthroughArguments);
  // The message goes last: it is a positional argument after all flags.
  let message = fillTemplate(entryPoint.message, templateValues);
  if (request.queueItem !== undefined) {
    if (entryPoint.queue === undefined) {
      throw new Error(`entry point '${request.entryPointName}' has no queue`);
    }
    const preamble = fillTemplate(entryPoint.queue.preamble, {
      ...templateValues,
      [QUEUE_PLACEHOLDERS.position]: String(request.queueItem.position),
      [QUEUE_PLACEHOLDERS.count]: String(request.queueItem.count),
      [QUEUE_PLACEHOLDERS.roundLimit]: request.queueItem.roundLimitText,
    });
    message = `${preamble}${PREAMBLE_SEPARATOR}${message}`;
  }
  commandWords.push(message);

  const pathEntries = [...request.manifest.pathDirectories];
  if (request.inheritedPath !== "") {
    pathEntries.push(request.inheritedPath);
  }

  return {
    preparationSteps,
    commandWords,
    workingDirectory,
    pathEnvironment: pathEntries.join(delimiter),
  };
}
