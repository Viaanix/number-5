// End-to-end tests of `j5` against the real issue-team manifest in this repository.
// stdin is a pipe, so the launcher never prompts: every missing value is an error.
// The launch test puts a fake `docker` first on PATH so nothing reaches a model.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { LAUNCHER_SWITCH_NAMES, LAUNCHER_VALUE_OPTION_NAMES } from "../src/arguments.ts";
import { formatUsage } from "../src/cli.ts";
import { readPathValue, withPathValue } from "../src/environment.ts";
import { loadManifest } from "../src/manifest.ts";
import {
  quoteForPosixShell,
  quoteForPowerShell,
  renderPlanAsShellCommand,
  shellDialectForPlatform,
} from "../src/shell-quote.ts";
import { fillTemplate } from "../src/template.ts";
import {
  addPullRequestToOrigin,
  createFixtureProject,
  createTemporaryDirectory,
  FIXTURE_DEFAULT_BRANCH,
  FIXTURE_FEATURE_BRANCH,
  removeTemporaryDirectories,
  runGit,
  writeFakeExecutable,
} from "./fixtures.ts";

afterAll(removeTemporaryDirectories);

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_PATH = join(REPOSITORY_ROOT, "launcher", "src", "cli.ts");
const ISSUE_TEAM_DIRECTORY = join(REPOSITORY_ROOT, "workflows", "issue-team");
const ISSUE_TEAM_CONFIG = join(ISSUE_TEAM_DIRECTORY, "team.yaml");
const ISSUE_TEAM_BIN = join(ISSUE_TEAM_DIRECTORY, "bin");
const ISSUE_TEAM_MANIFEST = loadManifest(join(ISSUE_TEAM_DIRECTORY, "workflow.yaml"));

// The first message j5 must send: the entry point's whole prompt from the real
// manifest, filled. Read rather than copied, so the tests follow prompt edits but
// still fail when the launcher sends anything else.
function expectedFirstMessage(
  entryPointName: string,
  parameterValues: Record<string, string>,
): string {
  const entryPoint = ISSUE_TEAM_MANIFEST.entrypoints[entryPointName];
  if (entryPoint === undefined) {
    throw new Error(`issue-team has no entry point ${entryPointName}`);
  }
  return fillTemplate(entryPoint.message, parameterValues);
}
const EXIT_CODE_USAGE = 2;

const RUNNING_ON_WINDOWS = process.platform === "win32";

// The exit code fixtures/fake-docker.ts ends with; the launcher must pass it through.
const FAKE_DOCKER_EXIT_CODE = 7;

// The canonical native form of a path, matching what the launcher prints (it
// normalizes git's C:/... and Windows 8.3 short names the same way).
function canonicalPath(path: string): string {
  return realpathSync.native(path);
}

// Where j5 puts a worktree: beside the project, under the given name.
function expectedWorktreePath(projectRoot: string, worktreeName: string): string {
  return join(dirname(canonicalPath(projectRoot)), worktreeName);
}

// The --print line for an expected plan, in this platform's dialect. The renderer has
// its own tests; these pin which steps and words the launcher puts in the plan.
function expectedPrintedCommand(
  preparationSteps: string[][],
  workingDirectory: string,
  commandWords: string[],
): string {
  return renderPlanAsShellCommand(
    { preparationSteps, commandWords, workingDirectory, pathEnvironment: "" },
    [ISSUE_TEAM_BIN],
    shellDialectForPlatform(process.platform),
  );
}

const quoteForThisPlatform = RUNNING_ON_WINDOWS ? quoteForPowerShell : quoteForPosixShell;

type CliResult = { exitCode: number; standardOutput: string; standardError: string };

function runCli(
  cliArguments: string[],
  workingDirectory: string,
  pathValue: string = readPathValue(process.env),
): CliResult {
  const completedProcess = Bun.spawnSync(["bun", CLI_PATH, ...cliArguments], {
    cwd: workingDirectory,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: withPathValue(process.env, pathValue),
  });
  return {
    exitCode: completedProcess.exitCode,
    standardOutput: completedProcess.stdout.toString().trim(),
    standardError: completedProcess.stderr.toString().trim(),
  };
}

describe("j5 --print", () => {
  test("work-issue: fetches the base, adds a worktree beside the project, starts docker-agent inside it", () => {
    const { projectRoot } = createFixtureProject("print-app");
    const root = canonicalPath(projectRoot);
    const worktreePath = expectedWorktreePath(projectRoot, "print-app-issue-12");
    const result = runCli(["issue-team", "work-issue", "--issue", "12", "--print"], projectRoot);
    expect(result).toEqual({
      exitCode: 0,
      standardOutput: expectedPrintedCommand(
        [
          ["git", "-C", root, "fetch", "origin", FIXTURE_DEFAULT_BRANCH],
          [
            "git",
            "-C",
            root,
            "worktree",
            "add",
            "-b",
            "worktree-print-app-issue-12",
            worktreePath,
            `origin/${FIXTURE_DEFAULT_BRANCH}`,
          ],
        ],
        worktreePath,
        [
          "docker",
          "agent",
          "run",
          ISSUE_TEAM_CONFIG,
          "--agent",
          "root",
          "--working-dir",
          worktreePath,
          expectedFirstMessage("work-issue", { issue: "12" }),
        ],
      ),
      standardError: "",
    });
    // --print has no side effects: the worktree is only described.
    expect(existsSync(worktreePath)).toBe(false);
  });

  test("--project, --base, --effort and passthrough flags all reach the command", () => {
    const { projectRoot } = createFixtureProject("flags-app");
    const elsewhere = createTemporaryDirectory();
    const worktreePath = expectedWorktreePath(projectRoot, "flags-app-closeout-pr-7");
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
    expect(result.standardOutput).toContain(
      `fetch origin ${quoteForThisPlatform(FIXTURE_FEATURE_BRANCH)}`,
    );
    expect(result.standardOutput).toEndWith(
      `--agent closeout --flavor low --working-dir ${quoteForThisPlatform(worktreePath)} --safety balanced ${quoteForThisPlatform(expectedFirstMessage("closeout", { pr: "7" }))}${RUNNING_ON_WINDOWS ? " }" : ""}`,
    );
  });

  // Catches a PR worktree that is not on the PR's own branch, found without gh: the
  // fixture origin is a local bare repository with no GitHub behind it.
  test("pr-followup: finds the PR's branch with git and adds a worktree tracking it", () => {
    const { projectRoot } = createFixtureProject("followup-app");
    const branchName = addPullRequestToOrigin(projectRoot, 7);
    const root = canonicalPath(projectRoot);
    const worktreePath = expectedWorktreePath(projectRoot, "followup-app-pr-7");
    const result = runCli(["issue-team", "pr-followup", "--pr", "7", "--print"], projectRoot);
    expect(result).toEqual({
      exitCode: 0,
      standardOutput: expectedPrintedCommand(
        [
          ["git", "-C", root, "fetch", "origin", branchName],
          [
            "git",
            "-C",
            root,
            "worktree",
            "add",
            "--track",
            "-b",
            branchName,
            worktreePath,
            `origin/${branchName}`,
          ],
        ],
        worktreePath,
        [
          "docker",
          "agent",
          "run",
          ISSUE_TEAM_CONFIG,
          "--agent",
          "followup",
          "--working-dir",
          worktreePath,
          expectedFirstMessage("pr-followup", { pr: "7" }),
        ],
      ),
      standardError: "",
    });
  });

  test("pr-followup: reports a PR number origin does not have", () => {
    const { projectRoot } = createFixtureProject("missing-pr-app");
    const result = runCli(["issue-team", "pr-followup", "--pr", "8", "--print"], projectRoot);
    expect(result.exitCode).not.toBe(0);
    expect(result.standardOutput).toBe("");
    expect(result.standardError).toContain("origin has no pull request #8");
  });
});

// Runs j5 attached to a pseudo-terminal (Bun.Terminal), so the launcher believes it
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

describe("j5 in a terminal", () => {
  // Both cases stop at a prompt; the run is killed at the timeout, which is expected.
  test("bare j5 opens with the Need input! banner, then the team picker", async () => {
    const result = await runCliInTerminal([], createTemporaryDirectory());
    expect(result.timedOut).toBe(true);
    expect(result.screenText).toContain("Need input!");
    expect(result.screenText).toContain("Team");
    expect(result.screenText.indexOf("Need input!")).toBeLessThan(
      result.screenText.indexOf("Team"),
    );
  });

  test("asks for a missing parameter as Need input: <label>", async () => {
    const { projectRoot } = createFixtureProject("prompt-app");
    const result = await runCliInTerminal(
      [
        "issue-team",
        "work-issue",
        "--effort",
        "low",
        "--base",
        `origin/${FIXTURE_DEFAULT_BRANCH}`,
        "--print",
      ],
      projectRoot,
    );
    expect(result.timedOut).toBe(true);
    expect(result.screenText).toContain("Need input: Issue number");
  });

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
    // The worktree is added from the repository root, not the subdirectory j5 started in.
    expect(result.screenText).toContain(
      `-C ${quoteForThisPlatform(canonicalPath(projectRoot))} worktree add -b worktree-terminal-app-issue-12`,
    );
  });
});

describe("j5 usage errors", () => {
  // Every case here exits before touching the repository, so they share one fixture;
  // building one per case cost about 8 git processes each, which is slow on Windows.
  let usageProjectRoot = "";
  beforeAll(() => {
    usageProjectRoot = createFixtureProject("usage-app").projectRoot;
  });

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
    [[], "name a team, or run j5 in a terminal to pick one"],
  ])("j5 %p exits 2 with a specific message", (cliArguments, expectedMessage) => {
    const result = runCli([...cliArguments, "--print"], usageProjectRoot);
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

describe("j5 launching", () => {
  test("creates the worktree, runs docker inside it with the team's bin first on PATH, returns its exit code", () => {
    const { projectRoot } = createFixtureProject("launch-app");
    const fakeBinDirectory = createTemporaryDirectory();
    // An executable, not a .cmd: the first message is a multi-line prompt, which
    // cmd.exe would cut at the first newline on Windows (see writeFakeExecutable).
    writeFakeExecutable(
      fakeBinDirectory,
      "docker",
      join(import.meta.dir, "fixtures", "fake-docker.ts"),
    );

    const worktreePath = expectedWorktreePath(projectRoot, "launch-app-issue-5");
    const launchEnvironmentPath = `${fakeBinDirectory}${delimiter}${readPathValue(process.env)}`;
    const launchArguments = ["issue-team", "work-issue", "--issue", "5", "--project", projectRoot];
    const expectedDockerCall = {
      workingDirectory: worktreePath,
      firstPathEntry: ISSUE_TEAM_BIN,
      arguments: [
        "agent",
        "run",
        ISSUE_TEAM_CONFIG,
        "--agent",
        "root",
        "--working-dir",
        worktreePath,
        expectedFirstMessage("work-issue", { issue: "5" }),
      ],
    };

    // Started from an unrelated directory, so the working-directory check proves the
    // launcher moved into the worktree rather than inheriting the caller's directory.
    const result = runCli(launchArguments, createTemporaryDirectory(), launchEnvironmentPath);

    expect(result.exitCode).toBe(FAKE_DOCKER_EXIT_CODE);
    // git's own output may precede the fake docker's JSON line.
    expect(JSON.parse(result.standardOutput.trim().split("\n").at(-1) ?? "")).toEqual(
      expectedDockerCall,
    );
    // The worktree is real, on its own branch; the user's checkout did not move.
    expect(runGit(worktreePath, ["branch", "--show-current"])).toBe("worktree-launch-app-issue-5");
    expect(runGit(projectRoot, ["branch", "--show-current"])).toBe(FIXTURE_DEFAULT_BRANCH);
    // Without prompts there is no confirmation, so the command is echoed as a receipt.
    expect(result.standardError).toContain(`j5: `);

    // Catches a rerun failing on `git worktree add` for a worktree that already exists.
    const rerun = runCli(launchArguments, createTemporaryDirectory(), launchEnvironmentPath);
    expect(rerun.exitCode).toBe(FAKE_DOCKER_EXIT_CODE);
    expect(JSON.parse(rerun.standardOutput.trim())).toEqual(expectedDockerCall);
  });
});

describe("j5 list and help", () => {
  test("list shows each issue-team entry point with its parameter, and the efforts", () => {
    const result = runCli(["list"], createTemporaryDirectory());
    expect(result.exitCode).toBe(0);
    // The flavor header sits above the real listing, which must still follow it.
    expect(result.standardOutput).toStartWith("Input! Input!\n\nissue-team — ");
    expect(result.standardOutput).toContain("  work-issue --issue <integer>");
    expect(result.standardOutput).toContain("  pr-followup --pr <integer>");
    expect(result.standardOutput).toContain("  closeout --pr <integer>");
    expect(result.standardOutput).toContain("  efforts: low");
  });

  // Catches the usage line of a parameterless entry point ending in a space, which
  // the separator before the (empty) parameter list used to add.
  test("list shows a parameterless entry point as its bare name", () => {
    const result = runCli(["list"], createTemporaryDirectory());
    expect(result.standardOutput).toContain("\n  review-branch\n");
  });

  test("help opens with the greeting, then the usage", () => {
    expect(formatUsage()).toStartWith("j5 — Number 5 is alive.\n\nUsage:\n");
  });

  test("help documents every launcher flag", () => {
    const usage = formatUsage();
    for (const optionName of [...LAUNCHER_VALUE_OPTION_NAMES, ...LAUNCHER_SWITCH_NAMES]) {
      expect(usage).toContain(`--${optionName}`);
    }
  });
});
