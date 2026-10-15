// Git and GitHub lookups the launcher needs before it can build a docker-agent command.
// Everything here shells out synchronously; the launcher is interactive and does one
// lookup at a time, so there is nothing to gain from async.

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

/** The remote every lookup and fetch uses, as everywhere else in the launcher. */
export const ORIGIN_REMOTE_NAME = "origin";

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
  // On Windows git prints `C:/Users/...` with forward slashes, while Node APIs may
  // hand out 8.3 short names (`C:\Users\RUNNER~1\...`) for the same directory. The
  // canonical native path makes both compare equal and look native in output.
  return realpathSync.native(resolve(result.standardOutput));
}

/** Returns the URL of the `origin` remote, or undefined when there is none. */
export function readOriginUrl(repositoryRoot: string): string | undefined {
  const result = runCommand(["git", "remote", "get-url", "origin"], repositoryRoot);
  return result.exitCode === SUCCESS_EXIT_CODE ? result.standardOutput : undefined;
}

/**
 * Returns the remote default branch as a remote-tracking ref, e.g. `origin/main`.
 * Uses origin/HEAD when the clone has it, otherwise asks GitHub (some clones never set it).
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
 * What already exists at the path j5 wants a worktree at.
 * - absent: nothing there; j5 creates the worktree.
 * - reusable: a linked worktree of this same repository, rooted at that path; continue in it.
 * - foreign: anything else (another repository's worktree, a plain directory, a file).
 */
export type WorktreeState = { kind: "absent" } | { kind: "reusable" } | { kind: "foreign" };

function readAbsoluteGitPath(directory: string, gitOption: string): string | undefined {
  const result = runCommand(["git", "rev-parse", "--path-format=absolute", gitOption], directory);
  if (result.exitCode !== SUCCESS_EXIT_CODE) {
    return undefined;
  }
  return realpathSync.native(resolve(result.standardOutput));
}

/**
 * Inspects the path j5 wants a worktree at. Reusable means: a linked worktree
 * (not the main checkout) whose root is exactly that path and whose repository
 * is the project's, so a resumed run continues on the same branch.
 */
export function inspectWorktreePath(repositoryRoot: string, worktreePath: string): WorktreeState {
  if (!existsSync(worktreePath)) {
    return { kind: "absent" };
  }
  const worktreeToplevel = readAbsoluteGitPath(worktreePath, "--show-toplevel");
  const worktreeCommonDirectory = readAbsoluteGitPath(worktreePath, "--git-common-dir");
  const worktreeGitDirectory = readAbsoluteGitPath(worktreePath, "--git-dir");
  const projectCommonDirectory = readAbsoluteGitPath(repositoryRoot, "--git-common-dir");
  const isLinkedWorktreeOfProject =
    worktreeToplevel === realpathSync.native(worktreePath) &&
    worktreeCommonDirectory !== undefined &&
    worktreeCommonDirectory === projectCommonDirectory &&
    worktreeGitDirectory !== worktreeCommonDirectory;
  return isLinkedWorktreeOfProject ? { kind: "reusable" } : { kind: "foreign" };
}

/** True when the repository has a local branch with this name. */
export function localBranchExists(repositoryRoot: string, branchName: string): boolean {
  const result = runCommand(
    ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    repositoryRoot,
  );
  return result.exitCode === SUCCESS_EXIT_CODE;
}

// One `<sha>\t<ref>` line of `git ls-remote` output.
const LS_REMOTE_LINE_PATTERN = /^([0-9a-f]+)\t(\S+)$/;
const BRANCH_REF_PREFIX = "refs/heads/";

function listRemoteRefs(
  repositoryRoot: string,
  options: string[],
  refPatterns: string[],
): Array<{ sha: string; ref: string }> {
  const result = runCommand(
    // Options go before the remote: anything after it is read as a ref pattern.
    ["git", "ls-remote", ...options, ORIGIN_REMOTE_NAME, ...refPatterns],
    repositoryRoot,
  );
  if (result.exitCode !== SUCCESS_EXIT_CODE) {
    throw new Error(
      `git ls-remote ${ORIGIN_REMOTE_NAME} failed in ${repositoryRoot}: ${result.standardError}`,
    );
  }
  const refs: Array<{ sha: string; ref: string }> = [];
  for (const line of result.standardOutput.split("\n")) {
    const match = LS_REMOTE_LINE_PATTERN.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      refs.push({ sha: match[1], ref: match[2] });
    }
  }
  return refs;
}

/**
 * Finds the branch in origin that a pull request is built from, using git alone:
 * GitHub publishes each PR's head commit as refs/pull/<n>/head, and the PR's branch
 * is the origin branch whose tip is that commit. Git over SSH uses the same key as
 * every other fetch, so this needs no `gh` login or token.
 * @throws Error when origin has no such PR, or its head is not exactly one origin
 *   branch (a PR from a fork, or two branches at the same commit).
 */
export function resolvePullRequestBranch(
  repositoryRoot: string,
  pullRequestNumber: number,
): string {
  const pullRequestRef = `refs/pull/${pullRequestNumber}/head`;
  const [pullRequestHead] = listRemoteRefs(repositoryRoot, [], [pullRequestRef]);
  if (pullRequestHead === undefined) {
    throw new Error(
      `${ORIGIN_REMOTE_NAME} has no pull request #${pullRequestNumber} (no ${pullRequestRef})`,
    );
  }
  const branchNames = listRemoteRefs(repositoryRoot, ["--heads"], [])
    .filter((remoteRef) => remoteRef.sha === pullRequestHead.sha)
    .map((remoteRef) => remoteRef.ref.slice(BRANCH_REF_PREFIX.length));
  const [branchName, ...otherBranchNames] = branchNames;
  if (branchName === undefined) {
    throw new Error(
      `pull request #${pullRequestNumber}'s head ${pullRequestHead.sha.slice(0, 7)} is not the tip of any branch in ${ORIGIN_REMOTE_NAME}: a PR from a fork, or its branch moved since; j5 can only follow up on a branch of this repository`,
    );
  }
  if (otherBranchNames.length > 0) {
    throw new Error(
      `pull request #${pullRequestNumber}'s head is the tip of several ${ORIGIN_REMOTE_NAME} branches (${branchNames.join(", ")}); cannot tell which one the PR is built from`,
    );
  }
  return branchName;
}

// GitHub returns at most this many issues for one label; a queue longer than this is
// not something to run unattended in one go.
const LABEL_ISSUE_LIMIT = 200;

function isIssueNumberEntry(entry: unknown): entry is { number: number } {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "number" in entry &&
    typeof entry.number === "number" &&
    Number.isInteger(entry.number) &&
    entry.number > 0
  );
}

/**
 * Lists the numbers of the repository's open issues that carry the label, oldest
 * first, with `gh issue list`. Unlike the git lookups above this needs a gh login
 * (or GH_TOKEN) that can see the repository.
 * @throws Error when gh fails or prints something other than a list of issue numbers.
 */
export function listOpenIssuesWithLabel(repositoryRoot: string, label: string): string[] {
  const result = runCommand(
    [
      "gh",
      "issue",
      "list",
      "--label",
      label,
      "--state",
      "open",
      "--json",
      "number",
      "--limit",
      String(LABEL_ISSUE_LIMIT),
    ],
    repositoryRoot,
  );
  if (result.exitCode !== SUCCESS_EXIT_CODE) {
    throw new Error(
      `gh issue list --label ${label} failed: ${result.standardError}; --queue-label needs a gh login (or GH_TOKEN) that can see this repository`,
    );
  }
  const parsed: unknown = JSON.parse(result.standardOutput);
  if (!Array.isArray(parsed) || !parsed.every(isIssueNumberEntry)) {
    throw new Error(
      `gh issue list printed something other than issue numbers: ${result.standardOutput}`,
    );
  }
  return parsed
    .map((entry) => entry.number)
    .toSorted((left, right) => left - right)
    .map(String);
}
