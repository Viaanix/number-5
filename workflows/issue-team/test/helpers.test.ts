// Tests for the issue-team helpers (workflows/issue-team/helpers, launched by its bin/).
// Git helpers run against real temporary repositories. The last block calls the helpers
// by bare name through the same shells docker-agent's script tools use on each OS, with
// arguments in the environment.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  createFixtureProject,
  DOCKER_AGENT_SHELLS,
  FIXTURE_DEFAULT_BRANCH,
  type HelperResult,
  removeTemporaryDirectories,
  runGit,
  runHelperScriptFile,
  runThroughDockerAgentShell,
} from "#launcher-test/fixtures.ts";

afterAll(removeTemporaryDirectories);

const TEAM_DIRECTORY = resolve(import.meta.dir, "..");
const TEAM_BIN_DIRECTORY = join(TEAM_DIRECTORY, "bin");

function runHelperScript(
  helperName: string,
  helperArguments: string[],
  workingDirectory: string,
  extraEnvironment: Record<string, string> = {},
): HelperResult {
  return runHelperScriptFile(
    join(TEAM_DIRECTORY, "helpers", `${helperName}.ts`),
    helperArguments,
    workingDirectory,
    extraEnvironment,
  );
}

// A feature branch two commits ahead of origin/trunk, plus an uncommitted edit and an
// untracked file. Returns the repository and the SHA of the first feature commit.
function createFeatureBranchProject(): { projectRoot: string; firstCommit: string } {
  const { projectRoot } = createFixtureProject("diff-app");
  runGit(projectRoot, ["checkout", "--quiet", "-b", "feature"]);
  writeFileSync(join(projectRoot, "first.txt"), "first\n");
  runGit(projectRoot, ["add", "first.txt"]);
  runGit(projectRoot, ["commit", "--quiet", "-m", "add first file"]);
  const firstCommit = runGit(projectRoot, ["rev-parse", "--short", "HEAD"]);
  writeFileSync(join(projectRoot, "second.txt"), "second\n");
  runGit(projectRoot, ["add", "second.txt"]);
  runGit(projectRoot, ["commit", "--quiet", "-m", "add second file"]);
  writeFileSync(join(projectRoot, "first.txt"), "first, edited\n");
  writeFileSync(join(projectRoot, "untracked.txt"), "new\n");
  return { projectRoot, firstCommit };
}

describe("issue-team-change-diff", () => {
  let project: { projectRoot: string; firstCommit: string };
  beforeAll(() => {
    project = createFeatureBranchProject();
  });

  test("without since: full scope, both commits, and the uncommitted work", () => {
    const result = runHelperScript("change-diff", [], project.projectRoot);
    expect(result.exitCode).toBe(0);
    const lines = result.standardOutput.split("\n");
    expect(lines[0]).toBe("scope: full");
    expect(lines[1]).toStartWith(`base: origin/${FIXTURE_DEFAULT_BRANCH}  merge-base: `);
    expect(result.standardOutput).not.toContain("## New commits (review scope)");
    expect(result.standardOutput).toContain("add first file");
    expect(result.standardOutput).toContain("add second file");
    expect(result.standardOutput).toContain(
      "## Uncommitted work (not in the commits above; read ?? files directly)\n M first.txt\n?? untracked.txt\n",
    );
  });

  test("with since as an argument: the later commit is the review scope", () => {
    const result = runHelperScript("change-diff", [project.firstCommit], project.projectRoot);
    expect(result.exitCode).toBe(0);
    expect(result.standardOutput).toStartWith(`scope: new-commits since ${project.firstCommit}\n`);
    const reviewScope = result.standardOutput.split("## Full change (context only)")[0] ?? "";
    expect(reviewScope).toContain("add second file");
    expect(reviewScope).not.toContain("add first file");
  });

  test("with since from the environment, as docker-agent passes it", () => {
    const result = runHelperScript("change-diff", [], project.projectRoot, {
      since: project.firstCommit,
    });
    expect(result.standardOutput).toStartWith(`scope: new-commits since ${project.firstCommit}\n`);
  });

  test.each([
    ["deadbeef", "a SHA that does not exist"],
    ["not-a-sha", "not a SHA at all"],
  ])("falls back to full scope for since=%p (%s)", (since) => {
    const result = runHelperScript("change-diff", [since], project.projectRoot);
    expect(result.exitCode).toBe(0);
    expect(result.standardOutput).toStartWith(
      `scope: full (since '${since}' is not a commit in this branch's history, e.g. after a rebase or force-push)\n`,
    );
  });
});

// Adds an uncommitted test file containing `.only(` and registers it with
// `git add -N`, as the tester is told to before calling test_prescreen.
function addFocusedTestFile(projectRoot: string): void {
  writeFileSync(join(projectRoot, "focused.test.ts"), 'it.only("focused", () => {});\n');
  runGit(projectRoot, ["add", "-N", "focused.test.ts"]);
}

const STRICT_FAILURE_EXIT_CODE = 1;

describe("issue-team-test-prescreen", () => {
  test("passes a branch whose changes hold no fig-leaf signals", () => {
    const { projectRoot } = createFeatureBranchProject();
    const result = runHelperScript("test-prescreen", [], projectRoot);
    expect(result.exitCode).toBe(0);
    expect(result.standardOutput).toBe(
      "check-test-quality: no findings (0 test file(s) scanned)\n",
    );
  });

  test("fails on an uncommitted new test file with .only, naming file and line", () => {
    const { projectRoot } = createFeatureBranchProject();
    addFocusedTestFile(projectRoot);
    const result = runHelperScript("test-prescreen", [], projectRoot);
    expect(result.exitCode).toBe(STRICT_FAILURE_EXIT_CODE);
    expect(result.standardOutput).toContain("[HIGH] disabled-tests  focused.test.ts:1\n");
  });
});

describe.each(DOCKER_AGENT_SHELLS)(
  "helpers by bare name through $shellName",
  ({ commandPrefix }) => {
    function runThroughShell(
      command: string,
      workingDirectory: string,
      extraEnvironment: Record<string, string> = {},
    ): HelperResult {
      return runThroughDockerAgentShell(
        commandPrefix,
        TEAM_BIN_DIRECTORY,
        command,
        workingDirectory,
        extraEnvironment,
      );
    }

    test("issue-team-test-prescreen", () => {
      const { projectRoot } = createFeatureBranchProject();
      addFocusedTestFile(projectRoot);
      const result = runThroughShell("issue-team-test-prescreen", projectRoot);
      expect(result.exitCode).toBe(STRICT_FAILURE_EXIT_CODE);
      expect(result.standardOutput).toContain("[HIGH] disabled-tests  focused.test.ts:1\n");
    });

    test("issue-team-change-diff with since in the environment", () => {
      const { projectRoot, firstCommit } = createFeatureBranchProject();
      const result = runThroughShell("issue-team-change-diff", projectRoot, { since: firstCommit });
      expect(result.exitCode).toBe(0);
      expect(result.standardOutput).toStartWith(`scope: new-commits since ${firstCommit}\n`);
    });
  },
);
