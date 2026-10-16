// End-to-end tests of `j5` against the real workflow manifests in this repository.
// stdin is a pipe, so the launcher never prompts: every missing value is an error.
// The launch test puts a fake `docker` first on PATH so nothing reaches a model.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { z } from "zod";

import { LAUNCHER_SWITCH_NAMES, LAUNCHER_VALUE_OPTION_NAMES } from "../src/arguments.ts";
import { formatBanner } from "../src/banner.ts";
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
const TEAMS_DIRECTORY = join(REPOSITORY_ROOT, "workflows");
const ISSUE_TEAM_NAME = "issue-team";
const PR_REVIEWER_NAME = "pr-reviewer";

const ISSUE_TEAM_MANIFEST = loadManifest(join(TEAMS_DIRECTORY, ISSUE_TEAM_NAME, "workflow.yaml"));
const MANIFESTS_BY_TEAM = {
  [ISSUE_TEAM_NAME]: ISSUE_TEAM_MANIFEST,
  [PR_REVIEWER_NAME]: loadManifest(join(TEAMS_DIRECTORY, PR_REVIEWER_NAME, "workflow.yaml")),
};
const ISSUE_TEAM_CONFIG = ISSUE_TEAM_MANIFEST.teamConfigPath;
const ISSUE_TEAM_BIN = join(TEAMS_DIRECTORY, ISSUE_TEAM_NAME, "bin");

// The first message j5 must send: the entry point's whole prompt from the real
// manifest, filled. Read rather than copied, so the tests follow prompt edits but
// still fail when the launcher sends anything else.
function expectedFirstMessage(
  teamName: keyof typeof MANIFESTS_BY_TEAM,
  entryPointName: string,
  parameterValues: Record<string, string>,
): string {
  const entryPoint = MANIFESTS_BY_TEAM[teamName].entrypoints[entryPointName];
  if (entryPoint === undefined) {
    throw new Error(`${teamName} has no entry point ${entryPointName}`);
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
  teamName: keyof typeof MANIFESTS_BY_TEAM,
  preparationSteps: string[][],
  workingDirectory: string,
  commandWords: string[],
): string {
  return renderPlanAsShellCommand(
    { preparationSteps, commandWords, workingDirectory, pathEnvironment: "" },
    MANIFESTS_BY_TEAM[teamName].pathDirectories,
    shellDialectForPlatform(process.platform),
  );
}

const quoteForThisPlatform = RUNNING_ON_WINDOWS ? quoteForPowerShell : quoteForPosixShell;

type CliResult = { exitCode: number; standardOutput: string; standardError: string };

// issue-team's independence rule makes even `--print` ask `docker agent debug config` which
// models the team runs on, so every CLI run needs a `docker` that answers. Without this, a test
// passes only on a machine that has the docker-agent plugin (it failed on CI's macOS and
// Windows runners, which do not). Built once: on Windows it is a compiled executable.
let dockerStandInDirectory: string | undefined;
function pathWithDockerStandIn(): string {
  if (dockerStandInDirectory === undefined) {
    dockerStandInDirectory = createTemporaryDirectory();
    writeFakeExecutable(
      dockerStandInDirectory,
      "docker",
      join(import.meta.dir, "fixtures", "fake-docker.ts"),
    );
  }
  return `${dockerStandInDirectory}${delimiter}${readPathValue(process.env)}`;
}

function runCli(
  cliArguments: string[],
  workingDirectory: string,
  pathValue: string = pathWithDockerStandIn(),
  extraEnvironment: Record<string, string> = {},
): CliResult {
  // The Bun that is running this test, not whatever `bun` is on PATH: some tests give the launcher
  // a PATH with no tools in it, and it must still start.
  const completedProcess = Bun.spawnSync([process.execPath, CLI_PATH, ...cliArguments], {
    cwd: workingDirectory,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...withPathValue(process.env, pathValue), ...extraEnvironment },
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
        ISSUE_TEAM_NAME,
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
          "--flavor",
          "reviewer-on-opus",
          "--working-dir",
          worktreePath,
          expectedFirstMessage(ISSUE_TEAM_NAME, "work-issue", { issue: "12" }),
        ],
      ),
      // The launcher says which tier it put the reviewer on and why, so the choice is never silent.
      standardError:
        "j5: reviewer 'reviewer' runs on opus (builder sonnet, tester sonnet), so the review is independent",
    });
    // --print has no side effects: the worktree is only described.
    expect(existsSync(worktreePath)).toBe(false);
  });

  test("--project, --base, --model, --effort and passthrough flags all reach the command", () => {
    const { projectRoot } = createFixtureProject("flags-app");
    const elsewhere = createTemporaryDirectory();
    const worktreePath = expectedWorktreePath(projectRoot, "flags-app-issue-7");
    const result = runCli(
      [
        "issue-team",
        "work-issue",
        "--issue=7",
        `--project=${projectRoot}`,
        "--base",
        `origin/${FIXTURE_FEATURE_BRANCH}`,
        "--model",
        "haiku",
        "--effort",
        "medium",
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
      `--agent root --flavor model-haiku --flavor effort-medium --flavor reviewer-on-sonnet --working-dir ${quoteForThisPlatform(worktreePath)} --safety balanced ${quoteForThisPlatform(expectedFirstMessage(ISSUE_TEAM_NAME, "work-issue", { issue: "7" }))}${RUNNING_ON_WINDOWS ? " }" : ""}`,
    );
  });

  // Catches a PR review worktree that is not on the fetched PR head, found without gh:
  // the fixture origin is a local bare repository with no GitHub behind it.
  test("pr-reviewer review: finds the PR's branch with git and adds a detached worktree at its head", () => {
    const { projectRoot } = createFixtureProject("review-app");
    const branchName = addPullRequestToOrigin(projectRoot, 7);
    const root = canonicalPath(projectRoot);
    const worktreePath = expectedWorktreePath(projectRoot, "review-app-pr-7-detached");
    const result = runCli(["pr-reviewer", "review", "--pr", "7", "--print"], projectRoot);
    expect(result).toEqual({
      exitCode: 0,
      standardOutput: expectedPrintedCommand(
        PR_REVIEWER_NAME,
        [
          ["git", "-C", root, "fetch", "origin", branchName],
          ["git", "-C", root, "worktree", "add", "--detach", worktreePath, "FETCH_HEAD"],
        ],
        worktreePath,
        [
          "docker",
          "agent",
          "run",
          MANIFESTS_BY_TEAM[PR_REVIEWER_NAME].teamConfigPath,
          "--agent",
          "reviewer",
          "--working-dir",
          worktreePath,
          expectedFirstMessage(PR_REVIEWER_NAME, "review", { pr: "7" }),
        ],
      ),
      standardError: "",
    });
  });

  test("pr-reviewer review: reports a PR number origin does not have", () => {
    const { projectRoot } = createFixtureProject("missing-pr-app");
    const result = runCli(["pr-reviewer", "review", "--pr", "8", "--print"], projectRoot);
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
// A pseudo-terminal delivers its output asynchronously, and on Windows (ConPTY) text written
// just before the process exits can reach the reader after `exited` resolves. A caller that
// reads output of a run that ends by itself passes the text it expects; the run then waits for
// that text to arrive. This bound only ends the wait when it never does (the caller's own
// assertion then fails with what the screen held), so a passing run never waits for it.
const TERMINAL_OUTPUT_BOUND_MILLISECONDS = 2000;

type TerminalRunResult = { exitCode: number; timedOut: boolean; screenText: string };

async function runCliInTerminal(
  cliArguments: string[],
  workingDirectory: string,
  expectedOutput?: string,
): Promise<TerminalRunResult> {
  const decoder = new TextDecoder();
  let rawScreen = "";
  const expectedOutputSeen = Promise.withResolvers<void>();
  await using terminal = new Bun.Terminal({
    cols: TERMINAL_COLUMNS,
    rows: TERMINAL_ROWS,
    data(_terminal, data) {
      rawScreen += decoder.decode(data);
      if (
        expectedOutput !== undefined &&
        stripVTControlCharacters(rawScreen).replaceAll("\r", "").includes(expectedOutput)
      ) {
        expectedOutputSeen.resolve();
      }
    },
  });
  const childProcess = Bun.spawn(["bun", CLI_PATH, ...cliArguments], {
    cwd: workingDirectory,
    env: withPathValue(process.env, pathWithDockerStandIn()),
    terminal,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    childProcess.kill();
  }, TERMINAL_RUN_TIMEOUT_MILLISECONDS);
  const exitCode = await childProcess.exited;
  clearTimeout(timer);
  if (expectedOutput !== undefined) {
    const giveUpTimer = setTimeout(expectedOutputSeen.resolve, TERMINAL_OUTPUT_BOUND_MILLISECONDS);
    await expectedOutputSeen.promise;
    clearTimeout(giveUpTimer);
  }
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
      ["pr-reviewer", "review", "--model", "sonnet", "--effort", "low", "--print"],
      projectRoot,
    );
    expect(result.timedOut).toBe(true);
    expect(result.screenText).toContain("Need input: Pull request number");
  });

  // Catches a queue-capable entry point that never offers the queue in a terminal,
  // or asks for a single issue number before knowing whether one is wanted.
  test("asks whether to run one issue or a queue when work-issue gets neither", async () => {
    const { projectRoot } = createFixtureProject("queue-prompt-app");
    const result = await runCliInTerminal(
      [
        "issue-team",
        "work-issue",
        "--model",
        "sonnet",
        "--effort",
        "low",
        "--base",
        `origin/${FIXTURE_DEFAULT_BRANCH}`,
        "--print",
      ],
      projectRoot,
    );
    expect(result.timedOut).toBe(true);
    expect(result.screenText).toContain("Run work-issue on");
    expect(result.screenText).toContain("a queue of issue numbers");
    expect(result.screenText).not.toContain("Need input: Issue number");
  });

  test("uses the repository around the current directory without asking for it", async () => {
    const { projectRoot } = createFixtureProject("terminal-app");
    const subdirectory = join(projectRoot, "src", "deep");
    mkdirSync(subdirectory, { recursive: true });
    // Every other value is a flag, so the project is the only thing left to ask about.
    // The worktree is added from the repository root, not the subdirectory j5 started in.
    const expectedWorktreeStep = `-C ${quoteForThisPlatform(canonicalPath(projectRoot))} worktree add -b worktree-terminal-app-issue-12`;
    const result = await runCliInTerminal(
      [
        "issue-team",
        "work-issue",
        "--issue",
        "12",
        "--model",
        "sonnet",
        "--effort",
        "low",
        "--base",
        `origin/${FIXTURE_DEFAULT_BRANCH}`,
        "--print",
      ],
      subdirectory,
      expectedWorktreeStep,
    );
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.screenText).toContain(expectedWorktreeStep);
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
      "--effort 'lwo' is not an effort of this team; choose one of: low, medium, high, xhigh",
    ],
    [
      ["issue-team", "work-issue", "--issue", "12", "--model", "hiaku"],
      "--model 'hiaku' is not a model tier of this team; choose one of: haiku, sonnet, opus",
    ],
    // The reviewer's flavors are j5's choice, never a user's: they are no effort and no model.
    [
      ["issue-team", "work-issue", "--issue", "12", "--effort", "reviewer-on-opus"],
      "--effort 'reviewer-on-opus' is not an effort of this team",
    ],
    [
      ["issue-team", "work-issue", "--issue", "12", "--model", "reviewer-on-opus"],
      "--model 'reviewer-on-opus' is not a model tier of this team",
    ],
    [["issue-team", "work-issue"], "missing --issue <integer> (Issue number)"],
    [
      ["issue-team", "work-issue", "--issue", "12", "--pr", "3"],
      "unknown option(s) for issue-team work-issue: --pr",
    ],
    [
      ["pr-reviewer", "review", "--pr", "3", "--base", "origin/x"],
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
        "--flavor",
        "reviewer-on-opus",
        "--working-dir",
        worktreePath,
        expectedFirstMessage(ISSUE_TEAM_NAME, "work-issue", { issue: "5" }),
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

describe("j5 detached PR reviews", () => {
  let launchEnvironmentPath: string;

  beforeAll(() => {
    const fakeBinDirectory = createTemporaryDirectory();
    writeFakeExecutable(
      fakeBinDirectory,
      "docker",
      join(import.meta.dir, "fixtures", "fake-docker.ts"),
    );
    launchEnvironmentPath = `${fakeBinDirectory}${delimiter}${readPathValue(process.env)}`;
  });

  test("reviews the fetched PR head without moving an occupied, stale local branch or its dirty files", async () => {
    const { projectRoot } = createFixtureProject("occupied-review-app");
    const branchName = addPullRequestToOrigin(projectRoot, 7);
    const pullRequestHead = runGit(projectRoot, ["rev-parse", `origin/${branchName}`]);
    runGit(projectRoot, ["checkout", "--quiet", "-b", branchName, `origin/${branchName}`]);
    runGit(projectRoot, ["reset", "--quiet", "--hard", FIXTURE_DEFAULT_BRANCH]);
    const sourceHead = runGit(projectRoot, ["rev-parse", "HEAD"]);
    const localNotesPath = join(projectRoot, "local-notes.txt");
    await Bun.write(localNotesPath, "local work must survive\n");
    const sourceStatus = runGit(projectRoot, ["status", "--porcelain"]);

    const result = runCli(
      ["pr-reviewer", "review", "--pr", "7"],
      projectRoot,
      launchEnvironmentPath,
    );
    const reviewWorktree = expectedWorktreePath(projectRoot, "occupied-review-app-pr-7-detached");

    expect(result.exitCode).toBe(FAKE_DOCKER_EXIT_CODE);
    expect(runGit(reviewWorktree, ["rev-parse", "HEAD"])).toBe(pullRequestHead);
    expect(runGit(reviewWorktree, ["branch", "--show-current"])).toBe("");
    expect(runGit(projectRoot, ["branch", "--show-current"])).toBe(branchName);
    expect(runGit(projectRoot, ["rev-parse", "HEAD"])).toBe(sourceHead);
    expect(runGit(projectRoot, ["status", "--porcelain"])).toBe(sourceStatus);
    expect(readFileSync(localNotesPath, "utf8")).toBe("local work must survive\n");
  });
});

// The JSON line fixtures/fake-docker-queue.ts prints first, read from an item's log.
type FakeDockerCall = {
  issue: string;
  workingDirectory: string;
  unattended: boolean;
  message: string;
};

function readFakeDockerCall(logPath: string): FakeDockerCall {
  const parsed: unknown = JSON.parse(readFileSync(logPath, "utf8").split("\n")[0] ?? "");
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("issue" in parsed && typeof parsed.issue === "string") ||
    !("workingDirectory" in parsed && typeof parsed.workingDirectory === "string") ||
    !("unattended" in parsed && typeof parsed.unattended === "boolean") ||
    !("message" in parsed && typeof parsed.message === "string")
  ) {
    throw new Error(`${logPath} does not start with the fake docker's JSON line`);
  }
  return {
    issue: parsed.issue,
    workingDirectory: parsed.workingDirectory,
    unattended: parsed.unattended,
    message: parsed.message,
  };
}

describe("j5 queue", () => {
  // One run over six issues with a fake docker that plays a different outcome per
  // issue (fixtures/fake-docker-queue.ts). Catches: an outcome read from the exit code
  // instead of the RESULT line; one failed issue stopping the queue; a session-limit
  // failure not stopping it; items run without --exec or without the preamble first.
  test("runs each issue unattended in its own worktree, reports each outcome, stops when the agent cannot run", () => {
    const { projectRoot } = createFixtureProject("queue-app");
    // Issue 4's branch already exists, so `git worktree add -b` fails for it.
    runGit(projectRoot, ["branch", "worktree-queue-app-issue-4"]);
    const fakeBinDirectory = createTemporaryDirectory();
    writeFakeExecutable(
      fakeBinDirectory,
      "docker",
      join(import.meta.dir, "fixtures", "fake-docker-queue.ts"),
    );

    const result = runCli(
      ["issue-team", "work-issue", "--queue", "1,2,3,4,5,6", "--max-rounds", "2"],
      projectRoot,
      `${fakeBinDirectory}${delimiter}${readPathValue(process.env)}`,
    );

    expect(result.exitCode).toBe(1);
    // j5 reports paths under the canonical project path (macOS /private/var, Windows long names).
    const queueDirectory = join(canonicalPath(projectRoot), ".j5", "queue");
    const [runDirectoryName, ...otherRuns] = readdirSync(queueDirectory);
    expect(otherRuns).toEqual([]);
    const runDirectory = join(queueDirectory, runDirectoryName ?? "");
    const logPath = (issue: string) => join(runDirectory, `issue-${issue}.log`);
    const summaryLines = readFileSync(join(runDirectory, "summary.md"), "utf8").split("\n");
    expect(summaryLines.slice(0, 6)).toEqual([
      "# j5 queue: issue-team work-issue, unattended, issue 1, 2, 3, 4, 5, 6; at most 2 fix rounds",
      "",
      "1 of 6 opened a pull request.",
      "",
      `- #1: PR https://example.invalid/pull/101 (log: ${logPath("1")})`,
      `- #2: FAILED: the date parser test is still red after 2 rounds (log: ${logPath("2")})`,
    ]);
    // #3 and #5 quote the end of their output, which is long (it echoes the prompt).
    expect(summaryLines[6]).toStartWith("- #3: FAILED: no RESULT line (exit 1): ");
    expect(summaryLines[6]).toEndWith(
      `partial work, then the agent stopped (log: ${logPath("3")})`,
    );
    expect(summaryLines[7]).toBe(
      `- #4: FAILED: ${readFileSync(logPath("4"), "utf8").trim()} (log: ${logPath("4")})`,
    );
    expect(summaryLines[8]).toStartWith("- #5: STOPPED THE QUEUE: the agent could not run: ");
    expect(summaryLines[8]).toEndWith(
      `harness claude-code failed: wait: exit status 1 (log: ${logPath("5")})`,
    );
    expect(summaryLines.slice(9)).toEqual([
      "- #6: not run",
      "",
      "Stopped early: the agent could not run, so every later item would have failed the same way.",
      "",
    ]);
    expect(readFileSync(logPath("4"), "utf8")).toContain(
      "worktree add -b worktree-queue-app-issue-4",
    );
    expect(existsSync(logPath("6"))).toBe(false);

    // Every item that reached docker ran unattended, inside its own new worktree, with
    // the preamble before the prompt.
    for (const issue of ["1", "2", "3", "5"]) {
      const call = readFakeDockerCall(logPath(issue));
      const worktreePath = expectedWorktreePath(projectRoot, `queue-app-issue-${issue}`);
      expect(call).toMatchObject({ issue, workingDirectory: worktreePath, unattended: true });
      expect(call.message).toStartWith(
        `UNATTENDED QUEUE RUN — issue ${issue}, item ${issue} of 6.`,
      );
      expect(call.message).toContain(`\n\nWork issue #${issue}.`);
      expect(runGit(worktreePath, ["branch", "--show-current"])).toBe(
        `worktree-queue-app-issue-${issue}`,
      );
    }
    expect(existsSync(expectedWorktreePath(projectRoot, "queue-app-issue-6"))).toBe(false);
    expect(runGit(projectRoot, ["branch", "--show-current"])).toBe(FIXTURE_DEFAULT_BRANCH);
  });

  test("--print shows one command per issue and runs nothing", () => {
    const { projectRoot } = createFixtureProject("queue-print-app");
    const result = runCli(
      ["issue-team", "work-issue", "--queue", "7,8", "--max-rounds", "none", "--print"],
      projectRoot,
    );
    expect(result.exitCode).toBe(0);
    const lines = result.standardOutput
      .split("\n")
      .filter((line) => line.includes("docker agent run"));
    expect(lines).toHaveLength(2);
    expect(result.standardOutput).toContain("no limit on the number of fix rounds");
    expect(existsSync(join(projectRoot, ".j5"))).toBe(false);
  });

  // Catches a queue run without --max-rounds prompting or erroring instead of using
  // the default limit.
  test("--print without --max-rounds sends the default limit of 5 fix rounds", () => {
    const { projectRoot } = createFixtureProject("queue-default-rounds-app");
    const result = runCli(["issue-team", "work-issue", "--queue", "7,8", "--print"], projectRoot);
    expect(result.exitCode).toBe(0);
    expect(result.standardOutput).toContain("at most 5 fix rounds");
  });

  test.each([
    [
      ["--queue", "1", "--queue-label", "ready", "--max-rounds", "2"],
      "--queue and --queue-label are alternatives",
    ],
    [
      ["--queue", "1", "--issue", "2", "--max-rounds", "2"],
      "--issue runs one item; --queue / --queue-label run several",
    ],
    [
      ["--issue", "2", "--max-rounds", "2"],
      "--max-rounds only applies with --queue or --queue-label",
    ],
    [["--queue", "1,x", "--max-rounds", "2"], "--queue takes comma-separated positive integers"],
  ])("work-issue %p exits 2 with a specific message", (queueArguments, expectedMessage) => {
    const { projectRoot } = createFixtureProject("queue-usage-app");
    const result = runCli(["issue-team", "work-issue", ...queueArguments, "--print"], projectRoot);
    expect(result.exitCode).toBe(EXIT_CODE_USAGE);
    expect(result.standardError).toContain(expectedMessage);
  });

  test("refuses --queue for an entry point without a queue", () => {
    const { projectRoot } = createFixtureProject("queue-review-app");
    const result = runCli(["pr-reviewer", "review", "--queue", "1,2", "--print"], projectRoot);
    expect(result.exitCode).toBe(EXIT_CODE_USAGE);
    expect(result.standardError).toContain(
      "only apply to entry points with a queue; review has none",
    );
  });
});

describe("j5 list and help", () => {
  test("list shows each issue-team entry point with its parameter, the models and the efforts", () => {
    const result = runCli(["list"], createTemporaryDirectory());
    expect(result.exitCode).toBe(0);
    // The flavor header sits above the real listing, which must still follow it.
    expect(result.standardOutput).toStartWith("Input! Input!\n\nissue-team — ");
    expect(result.standardOutput).toContain("  work-issue --issue <integer>");
    expect(result.standardOutput).toContain("  models: haiku, sonnet, opus");
    expect(result.standardOutput).toContain("  efforts: low, medium, high, xhigh");
  });

  // Catches the usage line of a parameterless entry point ending in a space, which
  // the separator before the (empty) parameter list used to add.
  test("list shows a parameterless entry point as its bare name", () => {
    const result = runCli(["list"], createTemporaryDirectory());
    expect(result.standardOutput).toContain("\n  review-branch\n");
  });

  test("help opens with the banner, then the usage", () => {
    expect(formatUsage()).toStartWith(`${formatBanner()}\n\nUsage:\n`);
  });

  test("help documents every launcher flag", () => {
    const usage = formatUsage();
    for (const optionName of [...LAUNCHER_VALUE_OPTION_NAMES, ...LAUNCHER_SWITCH_NAMES]) {
      expect(usage).toContain(`--${optionName}`);
    }
  });
});

describe("j5 --version and j5 setup", () => {
  test("--version prints the package name and version from package.json", () => {
    const packageJson = z
      .object({ name: z.string(), version: z.string() })
      .parse(
        JSON.parse(readFileSync(resolve(import.meta.dir, "..", "..", "package.json"), "utf8")),
      );

    const result = runCli(["--version"], createTemporaryDirectory());

    expect(result).toEqual({
      exitCode: 0,
      standardOutput: `${packageJson.name} ${packageJson.version}`,
      standardError: "",
    });
  });

  // The real process, with a PATH that holds no tools and a home directory of its own: setup
  // must report each missing tool, exit non-zero, and in --check mode leave the home untouched.
  test("setup --check on a machine without the tools lists them as missing and changes nothing", () => {
    const emptyToolDirectory = createTemporaryDirectory();
    const homeDirectory = createTemporaryDirectory();

    const result = runCli(["setup", "--check"], createTemporaryDirectory(), emptyToolDirectory, {
      HOME: homeDirectory,
      USERPROFILE: homeDirectory,
    });

    expect(result.exitCode).toBe(1);
    expect(result.standardOutput).toContain("missing  git is not installed");
    expect(result.standardOutput).toContain("missing  gh is not installed");
    expect(result.standardOutput).toContain("missing  docker is not installed");
    expect(result.standardOutput).toContain("setup found problems above");
    expect(existsSync(join(homeDirectory, ".agents"))).toBe(false);
  });

  // Catches a setup-only flag silently doing nothing on a team launch, or setup quietly
  // ignoring a flag that does not belong to it.
  test.each([
    [["setup", "--print"], "--print does not apply to j5 setup"],
    [
      ["setup", "--check", "--login"],
      "--login changes things, so it cannot be combined with --check",
    ],
    [["setup", "extra"], "j5 setup takes only --check, --proxy and --login"],
    [["setup", "--project", "/tmp"], "j5 setup takes only --check, --proxy and --login"],
    [["issue-team", "work-issue", "--issue", "1", "--proxy"], "--proxy only applies to 'j5 setup'"],
    [["issue-team", "work-issue", "--issue", "1", "--check"], "--check only applies to 'j5 setup'"],
  ])("j5 %p is a usage error (exit 2)", (cliArguments, expectedMessage) => {
    const result = runCli(cliArguments, createTemporaryDirectory());

    expect(result.exitCode).toBe(2);
    expect(result.standardError).toContain(expectedMessage);
  });
});
