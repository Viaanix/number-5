// End-to-end tests of `daw` against the real issue-team manifest in this repository.
// stdin is a pipe, so the launcher never prompts: every missing value is an error.
// The launch test puts a fake `docker` first on PATH so nothing reaches a model.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { LAUNCHER_SWITCH_NAMES, LAUNCHER_VALUE_OPTION_NAMES } from "../src/arguments.ts";
import { formatUsage } from "../src/cli.ts";
import {
  createFixtureProject,
  createTemporaryDirectory,
  FIXTURE_DEFAULT_BRANCH,
  FIXTURE_FEATURE_BRANCH,
  removeTemporaryDirectories,
} from "./fixtures.ts";

afterAll(removeTemporaryDirectories);

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_PATH = join(REPOSITORY_ROOT, "launcher", "src", "cli.ts");
const ISSUE_TEAM_DIRECTORY = join(REPOSITORY_ROOT, "issue-team");
const ISSUE_TEAM_CONFIG = join(ISSUE_TEAM_DIRECTORY, "team.yaml");
const ISSUE_TEAM_BIN = join(ISSUE_TEAM_DIRECTORY, "bin");
const EXIT_CODE_USAGE = 2;

// A PR number no real ~/.cagent/worktrees/pr-<n> will have, so the state is "absent".
const UNUSED_PULL_REQUEST_NUMBER = "987654321";

type CliResult = { exitCode: number; standardOutput: string; standardError: string };

function runCli(
  cliArguments: string[],
  workingDirectory: string,
  environment: Record<string, string> = {},
): CliResult {
  const completedProcess = Bun.spawnSync(["bun", CLI_PATH, ...cliArguments], {
    cwd: workingDirectory,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment },
  });
  return {
    exitCode: completedProcess.exitCode,
    standardOutput: completedProcess.stdout.toString().trim(),
    standardError: completedProcess.stderr.toString().trim(),
  };
}

describe("daw --print", () => {
  test("work-issue: worktree named after the repository, from the remote default branch", () => {
    const { projectRoot } = createFixtureProject("print-app");
    const result = runCli(["issue-team", "work-issue", "--issue", "12", "--print"], projectRoot);
    expect(result).toEqual({
      exitCode: 0,
      standardOutput: `cd ${realpathSync(projectRoot)} && PATH=${ISSUE_TEAM_BIN}:"$PATH" docker agent run ${ISSUE_TEAM_CONFIG} --agent root --worktree=print-app-issue-12 --worktree-base origin/${FIXTURE_DEFAULT_BRANCH} 'Work issue #12'`,
      standardError: "",
    });
  });

  test("--project, --base, --effort and passthrough flags all reach the command", () => {
    const { projectRoot } = createFixtureProject("flags-app");
    const elsewhere = createTemporaryDirectory();
    const result = runCli(
      [
        "issue-team",
        "closeout",
        "--pr=7",
        `--project=${projectRoot}`,
        "--base",
        `origin/${FIXTURE_FEATURE_BRANCH}`,
        "--effort",
        "low",
        "--print",
        "--",
        "--safety",
        "balanced",
      ],
      elsewhere,
    );
    expect(result.exitCode).toBe(0);
    expect(result.standardOutput).toEndWith(
      `--agent closeout --flavor low --worktree=flags-app-closeout-pr-7 --worktree-base origin/${FIXTURE_FEATURE_BRANCH} --safety balanced 'PR #7 is merged. Close it out.'`,
    );
  });

  test("pr-followup: lets docker-agent create the PR worktree when none is kept", () => {
    const { projectRoot } = createFixtureProject("followup-app");
    const result = runCli(
      ["issue-team", "pr-followup", "--pr", UNUSED_PULL_REQUEST_NUMBER, "--print"],
      projectRoot,
    );
    expect(result.exitCode).toBe(0);
    expect(result.standardOutput).toContain(
      `--agent followup --worktree-pr ${UNUSED_PULL_REQUEST_NUMBER} 'Follow up on PR #${UNUSED_PULL_REQUEST_NUMBER}:`,
    );
  });
});

// Runs daw attached to a pseudo-terminal (Bun.Terminal), so the launcher believes it
// may prompt. A launcher stuck at a prompt is killed after the timeout, well inside
// bun test's default 5 s per-test limit, and reported as timedOut.
const TERMINAL_RUN_TIMEOUT_MILLISECONDS = 3000;
// Wide enough that the printed command never wraps.
const TERMINAL_COLUMNS = 400;
const TERMINAL_ROWS = 50;

type TerminalRunResult = { exitCode: number; timedOut: boolean; screenText: string };

async function runCliInTerminal(
  cliArguments: string[],
  workingDirectory: string,
): Promise<TerminalRunResult> {
  const decoder = new TextDecoder();
  let rawScreen = "";
  await using terminal = new Bun.Terminal({
    cols: TERMINAL_COLUMNS,
    rows: TERMINAL_ROWS,
    data(_terminal, data) {
      rawScreen += decoder.decode(data);
    },
  });
  const childProcess = Bun.spawn(["bun", CLI_PATH, ...cliArguments], {
    cwd: workingDirectory,
    terminal,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    childProcess.kill();
  }, TERMINAL_RUN_TIMEOUT_MILLISECONDS);
  const exitCode = await childProcess.exited;
  clearTimeout(timer);
  return {
    exitCode,
    timedOut,
    // Terminals end lines with \r\n and color with escape codes; neither is content.
    screenText: stripVTControlCharacters(rawScreen).replaceAll("\r", "").trim(),
  };
}

describe("daw in a terminal", () => {
  test("uses the repository around the current directory without asking for it", async () => {
    const { projectRoot } = createFixtureProject("terminal-app");
    const subdirectory = join(projectRoot, "src", "deep");
    mkdirSync(subdirectory, { recursive: true });
    // Every other value is a flag, so the project is the only thing left to ask about.
    const result = await runCliInTerminal(
      [
        "issue-team",
        "work-issue",
        "--issue",
        "12",
        "--effort",
        "low",
        "--base",
        `origin/${FIXTURE_DEFAULT_BRANCH}`,
        "--print",
      ],
      subdirectory,
    );
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.screenText).toStartWith(`cd ${realpathSync(projectRoot)} && `);
  });
});

describe("daw usage errors", () => {
  test.each([
    [
      ["issue-team", "work-issue", "--issue", "12", "--effort", "lwo"],
      "--effort 'lwo' is not a flavor of this team; choose one of: low",
    ],
    [["issue-team", "work-issue"], "missing --issue <integer> (Issue number)"],
    [
      ["issue-team", "work-issue", "--issue", "12", "--pr", "3"],
      "unknown option(s) for issue-team work-issue: --pr",
    ],
    [
      ["issue-team", "pr-followup", "--pr", "3", "--base", "origin/x"],
      "--base only applies to entry points that create a new worktree",
    ],
    [
      ["issue-team", "work-issue", "--issue", "12", "--base", "origin/nope"],
      "--base 'origin/nope' is not a commit",
    ],
    [["no-such-team"], "no team named 'no-such-team'; teams: issue-team"],
    [["issue-team", "deploy"], "team 'issue-team' has no entry point 'deploy'"],
    [["issue-team", "work-issue", "12"], "unexpected arguments: 12; parameters are flags"],
    [[], "name a team, or run daw in a terminal to pick one"],
  ])("daw %p exits 2 with a specific message", (cliArguments, expectedMessage) => {
    const { projectRoot } = createFixtureProject("usage-app");
    const result = runCli([...cliArguments, "--print"], projectRoot);
    expect(result.exitCode).toBe(EXIT_CODE_USAGE);
    expect(result.standardOutput).toBe("");
    expect(result.standardError).toContain(expectedMessage);
  });

  test("outside a git repository without --project", () => {
    const result = runCli(
      ["issue-team", "work-issue", "--issue", "1", "--print"],
      createTemporaryDirectory(),
    );
    expect(result.exitCode).toBe(EXIT_CODE_USAGE);
    expect(result.standardError).toContain("the current directory is not a git repository");
  });
});

describe("daw launching", () => {
  test("runs docker in the project with the team's bin first on PATH and returns its exit code", () => {
    const { projectRoot } = createFixtureProject("launch-app");
    const fakeBinDirectory = createTemporaryDirectory();
    const fakeDockerPath = join(fakeBinDirectory, "docker");
    const FAKE_DOCKER_EXIT_CODE = 7;
    // Records what the launcher actually spawned: working directory, where the
    // issue-team helper resolves from on PATH, and each argument on its own line.
    writeFileSync(
      fakeDockerPath,
      `#!/usr/bin/env bash
echo "cwd=$PWD"
echo "helper=$(command -v issue-team-base-ref)"
printf 'arg=%s\\n' "$@"
exit ${FAKE_DOCKER_EXIT_CODE}
`,
    );
    chmodSync(fakeDockerPath, 0o755);

    // Started from an unrelated directory, so the cwd check proves the launcher moved
    // into the project rather than inheriting the caller's directory.
    const result = runCli(
      ["issue-team", "work-issue", "--issue", "5", "--project", projectRoot],
      createTemporaryDirectory(),
      { PATH: `${fakeBinDirectory}:${process.env.PATH ?? ""}` },
    );

    expect(result.exitCode).toBe(FAKE_DOCKER_EXIT_CODE);
    expect(result.standardOutput.split("\n")).toEqual([
      `cwd=${realpathSync(projectRoot)}`,
      `helper=${join(ISSUE_TEAM_BIN, "issue-team-base-ref")}`,
      "arg=agent",
      "arg=run",
      `arg=${ISSUE_TEAM_CONFIG}`,
      "arg=--agent",
      "arg=root",
      "arg=--worktree=launch-app-issue-5",
      "arg=--worktree-base",
      `arg=origin/${FIXTURE_DEFAULT_BRANCH}`,
      "arg=Work issue #5",
    ]);
    // Without prompts there is no confirmation, so the command is echoed as a receipt.
    expect(result.standardError).toStartWith("daw: cd ");
  });
});

describe("daw list and help", () => {
  test("list shows each issue-team entry point with its parameter, and the efforts", () => {
    const result = runCli(["list"], createTemporaryDirectory());
    expect(result.exitCode).toBe(0);
    expect(result.standardOutput).toContain("  work-issue --issue <integer>");
    expect(result.standardOutput).toContain("  pr-followup --pr <integer>");
    expect(result.standardOutput).toContain("  closeout --pr <integer>");
    expect(result.standardOutput).toContain("  efforts: low");
  });

  test("help documents every launcher flag", () => {
    const usage = formatUsage();
    for (const optionName of [...LAUNCHER_VALUE_OPTION_NAMES, ...LAUNCHER_SWITCH_NAMES]) {
      expect(usage).toContain(`--${optionName}`);
    }
  });
});
