import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import {
  inspectWorktreePath,
  localBranchExists,
  resolvePullRequestBranch,
  listRemoteBranches,
  refExists,
  resolveDefaultBranchRef,
  resolveGitToplevel,
} from "../src/git.ts";
import {
  addPullRequestToOrigin,
  createFixtureProject,
  createTemporaryDirectory,
  FIXTURE_DEFAULT_BRANCH,
  FIXTURE_FEATURE_BRANCH,
  removeTemporaryDirectories,
  runGit,
} from "./fixtures.ts";

afterAll(removeTemporaryDirectories);

describe("resolveGitToplevel", () => {
  test("returns the repository root when given a subdirectory", () => {
    const { projectRoot } = createFixtureProject("toplevel-app");
    const subdirectory = join(projectRoot, "src", "deep");
    mkdirSync(subdirectory, { recursive: true });
    expect(resolveGitToplevel(subdirectory)).toBe(realpathSync.native(projectRoot));
  });

  test("rejects a directory outside any repository", () => {
    const plainDirectory = createTemporaryDirectory();
    expect(() => resolveGitToplevel(plainDirectory)).toThrow("is not inside a git repository");
  });

  test("rejects a path that does not exist", () => {
    expect(() => resolveGitToplevel("/no/such/j5/path")).toThrow("does not exist");
  });
});

describe("resolveDefaultBranchRef", () => {
  test("reads origin/HEAD, which a clone sets to the remote's default branch", () => {
    const { projectRoot } = createFixtureProject("default-branch-app");
    // The clone's checked-out branch must not leak into the answer.
    runGit(projectRoot, ["checkout", "--quiet", "-b", "local-work"]);
    expect(resolveDefaultBranchRef(projectRoot)).toBe(`origin/${FIXTURE_DEFAULT_BRANCH}`);
  });
});

describe("listRemoteBranches", () => {
  test("lists origin branches without the origin/HEAD alias", () => {
    const { projectRoot } = createFixtureProject("branches-app");
    expect(listRemoteBranches(projectRoot).toSorted()).toEqual(
      [`origin/${FIXTURE_DEFAULT_BRANCH}`, `origin/${FIXTURE_FEATURE_BRANCH}`].toSorted(),
    );
  });

  test("returns nothing for a repository without an origin", () => {
    const repositoryDirectory = createTemporaryDirectory();
    runGit(repositoryDirectory, ["init", "--quiet"]);
    expect(listRemoteBranches(repositoryDirectory)).toEqual([]);
  });
});

describe("refExists", () => {
  test("is true for a remote branch and false for a misspelled one", () => {
    const { projectRoot } = createFixtureProject("ref-app");
    expect(refExists(projectRoot, `origin/${FIXTURE_FEATURE_BRANCH}`)).toBe(true);
    expect(refExists(projectRoot, "origin/feature/logn")).toBe(false);
  });
});

describe("inspectWorktreePath", () => {
  test("reports absent when nothing is at the path", () => {
    const { projectRoot } = createFixtureProject("absent-app");
    expect(
      inspectWorktreePath(projectRoot, join(createTemporaryDirectory(), "absent-app-issue-1")),
    ).toEqual({
      kind: "absent",
    });
  });

  // Catches a reuse check that looks only at the origin URL: a second clone of the
  // same repository has the same origin but is a different repository on disk.
  test("reports reusable for a linked worktree of the project, rooted at the path", () => {
    const { projectRoot } = createFixtureProject("reuse-app");
    const worktreePath = join(createTemporaryDirectory(), "reuse-app-issue-1");
    runGit(projectRoot, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      "worktree-reuse-app-issue-1",
      worktreePath,
    ]);
    expect(inspectWorktreePath(projectRoot, worktreePath)).toEqual({ kind: "reusable" });
  });

  test("reports foreign for a worktree of another repository", () => {
    const { projectRoot } = createFixtureProject("ours-app");
    const otherProject = createFixtureProject("theirs-app");
    const worktreePath = join(createTemporaryDirectory(), "ours-app-pr-3");
    runGit(otherProject.projectRoot, ["worktree", "add", "--quiet", worktreePath]);
    expect(inspectWorktreePath(projectRoot, worktreePath)).toEqual({ kind: "foreign" });
  });

  // Catches running an agent in the user's own checkout, or in a subdirectory of a
  // worktree, as if it were the worktree j5 created.
  test("reports foreign for the main checkout itself, a subdirectory of a worktree, and a plain directory", () => {
    const { projectRoot } = createFixtureProject("main-app");
    const worktreePath = join(createTemporaryDirectory(), "main-app-issue-2");
    runGit(projectRoot, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      "worktree-main-app-issue-2",
      worktreePath,
    ]);
    const subdirectory = join(worktreePath, "src");
    mkdirSync(subdirectory);
    expect(inspectWorktreePath(projectRoot, projectRoot)).toEqual({ kind: "foreign" });
    expect(inspectWorktreePath(projectRoot, subdirectory)).toEqual({ kind: "foreign" });
    expect(inspectWorktreePath(projectRoot, createTemporaryDirectory())).toEqual({
      kind: "foreign",
    });
  });
});

describe("resolvePullRequestBranch", () => {
  test("finds the origin branch whose tip is the PR's head", () => {
    const { projectRoot } = createFixtureProject("pr-branch-app");
    const branchName = addPullRequestToOrigin(projectRoot, 7);
    expect(resolvePullRequestBranch(projectRoot, 7)).toBe(branchName);
  });

  test("refuses a PR number origin does not have", () => {
    const { projectRoot } = createFixtureProject("no-pr-app");
    expect(() => resolvePullRequestBranch(projectRoot, 8)).toThrow(
      "origin has no pull request #8 (no refs/pull/8/head)",
    );
  });

  // Catches a fork PR being followed up on a branch that is not the PR's: its head
  // commit exists in origin only under refs/pull, never as a branch tip.
  test("refuses a PR whose head is not the tip of any origin branch", () => {
    const { projectRoot } = createFixtureProject("fork-pr-app");
    runGit(projectRoot, ["commit", "--quiet", "--allow-empty", "-m", "from a fork"]);
    runGit(projectRoot, ["push", "--quiet", "origin", "HEAD:refs/pull/9/head"]);
    expect(() => resolvePullRequestBranch(projectRoot, 9)).toThrow(
      "is not the tip of any branch in origin: a PR from a fork",
    );
  });

  // The fixture's trunk and feature/login point at the same commit, so a PR at that
  // commit cannot be told apart.
  test("refuses when several origin branches share the PR's head", () => {
    const { projectRoot } = createFixtureProject("ambiguous-pr-app");
    runGit(projectRoot, [
      "push",
      "--quiet",
      "origin",
      `origin/${FIXTURE_DEFAULT_BRANCH}:refs/pull/10/head`,
    ]);
    expect(() => resolvePullRequestBranch(projectRoot, 10)).toThrow(
      `is the tip of several origin branches (${FIXTURE_FEATURE_BRANCH}, ${FIXTURE_DEFAULT_BRANCH})`,
    );
  });
});

describe("localBranchExists", () => {
  test("is true for the checked-out branch and false for a remote-only one", () => {
    const { projectRoot } = createFixtureProject("local-branch-app");
    expect(localBranchExists(projectRoot, FIXTURE_DEFAULT_BRANCH)).toBe(true);
    expect(localBranchExists(projectRoot, FIXTURE_FEATURE_BRANCH)).toBe(false);
  });
});
