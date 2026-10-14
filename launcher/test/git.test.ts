import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import {
  inspectPullRequestWorktree,
  listRemoteBranches,
  readOriginUrl,
  refExists,
  resolveDefaultBranchRef,
  resolveGitToplevel,
} from "../src/git.ts";
import {
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

describe("inspectPullRequestWorktree", () => {
  const PULL_REQUEST_NUMBER = 456;

  test("reports absent when docker-agent has no worktree for the PR", () => {
    const { projectRoot } = createFixtureProject("absent-app");
    const worktreesDirectory = createTemporaryDirectory();
    expect(
      inspectPullRequestWorktree(projectRoot, PULL_REQUEST_NUMBER, worktreesDirectory),
    ).toEqual({ kind: "absent" });
  });

  test("reports reusable when the kept worktree has the project's origin", () => {
    const { projectRoot } = createFixtureProject("reuse-app");
    const worktreesDirectory = createTemporaryDirectory();
    const worktreePath = join(worktreesDirectory, `pr-${PULL_REQUEST_NUMBER}`);
    runGit(projectRoot, ["worktree", "add", "--quiet", worktreePath]);

    expect(
      inspectPullRequestWorktree(projectRoot, PULL_REQUEST_NUMBER, worktreesDirectory),
    ).toEqual({ kind: "reusable", path: worktreePath });
  });

  test("reports foreign when the kept worktree belongs to a repository with another origin", () => {
    const { projectRoot } = createFixtureProject("ours-app");
    const otherProject = createFixtureProject("theirs-app");
    const worktreesDirectory = createTemporaryDirectory();
    const worktreePath = join(worktreesDirectory, `pr-${PULL_REQUEST_NUMBER}`);
    runGit(otherProject.projectRoot, ["worktree", "add", "--quiet", worktreePath]);

    expect(readOriginUrl(worktreePath)).toBe(otherProject.originPath);
    expect(
      inspectPullRequestWorktree(projectRoot, PULL_REQUEST_NUMBER, worktreesDirectory),
    ).toEqual({ kind: "foreign", path: worktreePath });
  });
});
