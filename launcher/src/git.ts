// Git and GitHub lookups the launcher needs before it can build a docker-agent command.
// Everything here shells out synchronously; the launcher is interactive and does one
// lookup at a time, so there is nothing to gain from async.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where docker-agent v1.145.0 creates `--worktree` and `--worktree-pr` checkouts
 * (its default `--data-dir` is ~/.cagent).
 */
export const DOCKER_AGENT_WORKTREES_DIRECTORY = join(homedir(), ".cagent", "worktrees");

const SUCCESS_EXIT_CODE = 0;

type CommandResult = { exitCode: number; standardOutput: string; standardError: string };

function runCommand(commandWords: string[], workingDirectory: string): CommandResult {
  const completedProcess = Bun.spawnSync(commandWords, {
    cwd: workingDirectory,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: completedProcess.exitCode,
    standardOutput: completedProcess.stdout.toString().trim(),
    standardError: completedProcess.stderr.toString().trim(),
  };
}

/**
 * Returns the top-level directory of the git repository containing the path.
 * @throws Error when the path does not exist or is not inside a git repository.
 */
export function resolveGitToplevel(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`project path ${path} does not exist`);
  }
  const result = runCommand(["git", "rev-parse", "--show-toplevel"], path);
  if (result.exitCode !== SUCCESS_EXIT_CODE) {
    throw new Error(`project path ${path} is not inside a git repository`);
  }
  return result.standardOutput;
}

/** Returns the URL of the `origin` remote, or undefined when there is none. */
export function readOriginUrl(repositoryRoot: string): string | undefined {
  const result = runCommand(["git", "remote", "get-url", "origin"], repositoryRoot);
  return result.exitCode === SUCCESS_EXIT_CODE ? result.standardOutput : undefined;
}

/**
 * Returns the remote default branch as a remote-tracking ref, e.g. `origin/main`.
 * Uses origin/HEAD when the clone has it, otherwise asks GitHub (some clones never set it).
 * Same lookup as issue-team/bin/issue-team-base-ref, which agents call by name inside a run.
 * @throws Error when neither source answers.
 */
export function resolveDefaultBranchRef(repositoryRoot: string): string {
  const symbolicRef = runCommand(
    ["git", "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"],
    repositoryRoot,
  );
  if (symbolicRef.exitCode === SUCCESS_EXIT_CODE && symbolicRef.standardOutput !== "") {
    return symbolicRef.standardOutput;
  }
  const github = runCommand(
    ["gh", "repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"],
    repositoryRoot,
  );
  if (github.exitCode === SUCCESS_EXIT_CODE && github.standardOutput !== "") {
    return `origin/${github.standardOutput}`;
  }
  throw new Error(
    `cannot find the default branch of ${repositoryRoot}: origin/HEAD is unset and gh failed (${github.standardError})`,
  );
}

/**
 * Lists the `origin/*` remote-tracking branches as of the last fetch, without origin/HEAD.
 * The list can be stale; docker-agent fetches the chosen base itself before branching.
 */
export function listRemoteBranches(repositoryRoot: string): string[] {
  const result = runCommand(
    ["git", "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"],
    repositoryRoot,
  );
  if (result.exitCode !== SUCCESS_EXIT_CODE || result.standardOutput === "") {
    return [];
  }
  // Depending on the git version, origin/HEAD's short name prints as "origin" or "origin/HEAD".
  return result.standardOutput
    .split("\n")
    .filter((branchName) => branchName.includes("/") && !branchName.endsWith("/HEAD"));
}

/** True when the ref names a commit in the repository. */
export function refExists(repositoryRoot: string, ref: string): boolean {
  const result = runCommand(
    ["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    repositoryRoot,
  );
  return result.exitCode === SUCCESS_EXIT_CODE;
}

/**
 * What already exists at docker-agent's worktree path for a pull request.
 * - absent: nothing there; docker-agent can create it with --worktree-pr.
 * - reusable: a kept worktree of this same repository; continue in it.
 * - foreign: a kept worktree of a different repository with the same PR number.
 */
export type PullRequestWorktreeState =
  | { kind: "absent" }
  | { kind: "reusable"; path: string }
  | { kind: "foreign"; path: string };

/**
 * Inspects docker-agent's worktree path for a PR number.
 * docker-agent names PR worktrees `pr-<number>` without the repository name, so the
 * same number in two repositories collides; the origin URL tells them apart.
 */
export function inspectPullRequestWorktree(
  repositoryRoot: string,
  pullRequestNumber: number,
  worktreesDirectory: string = DOCKER_AGENT_WORKTREES_DIRECTORY,
): PullRequestWorktreeState {
  const worktreePath = join(worktreesDirectory, `pr-${pullRequestNumber}`);
  if (!existsSync(worktreePath)) {
    return { kind: "absent" };
  }
  const worktreeOrigin = readOriginUrl(worktreePath);
  const projectOrigin = readOriginUrl(repositoryRoot);
  if (worktreeOrigin !== undefined && worktreeOrigin === projectOrigin) {
    return { kind: "reusable", path: worktreePath };
  }
  return { kind: "foreign", path: worktreePath };
}
