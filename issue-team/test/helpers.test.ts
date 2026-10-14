// Tests for the issue-team helpers (issue-team/helpers, launched by issue-team/bin).
// Git helpers run against real temporary repositories; pr-threads runs against a
// fake gh. The last block calls the helpers by bare name through the same shells
// docker-agent's script tools use on each OS, with arguments in the environment.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

import {
  findPathVariableName,
  readPathValue,
  withPathValue,
} from "../../launcher/src/environment.ts";
import {
  createFixtureProject,
  createTemporaryDirectory,
  FIXTURE_DEFAULT_BRANCH,
  removeTemporaryDirectories,
  runGit,
  writeFakeCommand,
} from "../../launcher/test/fixtures.ts";

afterAll(removeTemporaryDirectories);

const TEAM_DIRECTORY = resolve(import.meta.dir, "..");
const TEAM_BIN_DIRECTORY = join(TEAM_DIRECTORY, "bin");
const RUNNING_ON_WINDOWS = process.platform === "win32";
const USAGE_EXIT_CODE = 2;

type HelperResult = { exitCode: number; standardOutput: string; standardError: string };

function runHelperScript(
  helperName: string,
  helperArguments: string[],
  workingDirectory: string,
  extraEnvironment: Record<string, string> = {},
): HelperResult {
  const completedProcess = Bun.spawnSync(
    ["bun", join(TEAM_DIRECTORY, "helpers", `${helperName}.ts`), ...helperArguments],
    {
      cwd: workingDirectory,
      stdin: "ignore",
      env: { ...process.env, ...extraEnvironment },
    },
  );
  return {
    exitCode: completedProcess.exitCode,
    standardOutput: completedProcess.stdout.toString(),
    standardError: completedProcess.stderr.toString(),
  };
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

describe("issue-team-base-ref", () => {
  test("prints origin/HEAD's target as a remote-tracking ref", () => {
    const { projectRoot } = createFixtureProject("base-ref-app");
    expect(runHelperScript("base-ref", [], projectRoot)).toEqual({
      exitCode: 0,
      standardOutput: `origin/${FIXTURE_DEFAULT_BRANCH}\n`,
      standardError: "",
    });
  });
});

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

describe("issue-team-pr-threads", () => {
  // One resolved and two unresolved threads, in GitHub's field order.
  const GRAPHQL_RESPONSE = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: "T_resolved",
                isResolved: true,
                isOutdated: false,
                path: "a.ts",
                line: 1,
                comments: { nodes: [] },
              },
              {
                id: "T_open",
                isResolved: false,
                isOutdated: false,
                path: "b.ts",
                line: 7,
                comments: {
                  nodes: [
                    {
                      databaseId: 11,
                      author: { login: "reviewer" },
                      body: "rename this",
                      url: "https://example.invalid/11",
                    },
                  ],
                },
              },
              {
                id: "T_outdated",
                isResolved: false,
                isOutdated: true,
                path: "c.ts",
                line: null,
                comments: { nodes: [] },
              },
            ],
          },
        },
      },
    },
  };

  let fakeGhEnvironment: Record<string, string>;
  let logPath: string;
  beforeAll(() => {
    const fakeDirectory = createTemporaryDirectory();
    writeFakeCommand(fakeDirectory, "gh", join(import.meta.dir, "fixtures", "fake-gh.ts"));
    const responsePath = join(fakeDirectory, "response.json");
    writeFileSync(responsePath, JSON.stringify(GRAPHQL_RESPONSE));
    logPath = join(fakeDirectory, "gh-calls.jsonl");
    // Under the existing spelling (Path on Windows) so it replaces PATH, not duplicates it.
    const pathVariable = findPathVariableName(process.env);
    fakeGhEnvironment = {
      [pathVariable]: `${fakeDirectory}${delimiter}${readPathValue(process.env)}`,
      FAKE_GH_LOG: logPath,
      FAKE_GH_GRAPHQL_RESPONSE: responsePath,
    };
  });

  test("prints each unresolved thread as one JSON line, without isResolved, in GitHub's field order", () => {
    const result = runHelperScript(
      "pr-threads",
      ["456"],
      createTemporaryDirectory(),
      fakeGhEnvironment,
    );
    expect({ exitCode: result.exitCode, standardError: result.standardError }).toEqual({
      exitCode: 0,
      standardError: "",
    });
    expect(result.standardOutput).toBe(
      `${JSON.stringify({ id: "T_open", isOutdated: false, path: "b.ts", line: 7, comments: { nodes: [{ databaseId: 11, author: { login: "reviewer" }, body: "rename this", url: "https://example.invalid/11" }] } })}\n` +
        `${JSON.stringify({ id: "T_outdated", isOutdated: true, path: "c.ts", line: null, comments: { nodes: [] } })}\n`,
    );
  });

  test("asks GitHub for this repository's PR, with the number from the environment", () => {
    const result = runHelperScript("pr-threads", [], createTemporaryDirectory(), {
      ...fakeGhEnvironment,
      pr: "789",
    });
    expect({ exitCode: result.exitCode, standardError: result.standardError }).toEqual({
      exitCode: 0,
      standardError: "",
    });
    const lastCall: unknown = JSON.parse(
      readFileSync(logPath, "utf8").trim().split("\n").at(-1) ?? "[]",
    );
    expect(lastCall).toEqual(
      expect.arrayContaining(["api", "graphql", "owner=acme", "name=widgets", "pr=789"]),
    );
  });

  test.each([
    [["abc"], "not a PR number: abc"],
    [[], "usage: issue-team-pr-threads <pr-number> (or pr in the environment)"],
  ])("exits 2 for arguments %p", (helperArguments, expectedMessage) => {
    const result = runHelperScript(
      "pr-threads",
      helperArguments,
      createTemporaryDirectory(),
      fakeGhEnvironment,
    );
    expect(result.exitCode).toBe(USAGE_EXIT_CODE);
    expect(result.standardError).toBe(`issue-team-pr-threads: ${expectedMessage}\n`);
  });
});

// The shells docker-agent v1.145.0 runs script tools with: $SHELL -c on Unix
// (sh here, the strictest), PowerShell -Command or cmd.exe /C on Windows. Each
// call names the helper bare, with arguments only in the environment.
const DOCKER_AGENT_SHELLS: Array<{ shellName: string; commandPrefix: string[] }> =
  RUNNING_ON_WINDOWS
    ? [
        { shellName: "pwsh", commandPrefix: ["pwsh", "-NoProfile", "-NonInteractive", "-Command"] },
        { shellName: "cmd", commandPrefix: ["cmd.exe", "/d", "/c"] },
      ]
    : [{ shellName: "sh", commandPrefix: ["sh", "-c"] }];

describe.each(DOCKER_AGENT_SHELLS)(
  "helpers by bare name through $shellName",
  ({ commandPrefix }) => {
    function runThroughShell(
      command: string,
      workingDirectory: string,
      extraEnvironment: Record<string, string> = {},
    ): HelperResult {
      const environment = withPathValue(
        { ...process.env, ...extraEnvironment },
        `${TEAM_BIN_DIRECTORY}${delimiter}${readPathValue(process.env)}`,
      );
      const completedProcess = Bun.spawnSync([...commandPrefix, command], {
        cwd: workingDirectory,
        stdin: "ignore",
        env: environment,
      });
      return {
        exitCode: completedProcess.exitCode,
        standardOutput: completedProcess.stdout.toString().replaceAll("\r\n", "\n"),
        standardError: completedProcess.stderr.toString(),
      };
    }

    test("issue-team-base-ref", () => {
      const { projectRoot } = createFixtureProject("bare-base-ref-app");
      expect(runThroughShell("issue-team-base-ref", projectRoot)).toEqual({
        exitCode: 0,
        standardOutput: `origin/${FIXTURE_DEFAULT_BRANCH}\n`,
        standardError: "",
      });
    });

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
