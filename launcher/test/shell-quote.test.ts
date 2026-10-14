import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  quoteForPosixShell,
  quoteForPowerShell,
  renderPlanAsShellCommand,
  shellDialectForPlatform,
} from "../src/shell-quote.ts";
import { discoverTeams } from "../src/teams.ts";

const PRINT_ARGUMENTS_SCRIPT = join(import.meta.dir, "fixtures", "print-arguments.ts");

// Whole prompts, as harness teams send them: multi-line messages with backticks, `$`,
// quotes, `<…>` and Markdown. Read from every real manifest so a new prompt is covered too.
const REPOSITORY_ROOT = join(import.meta.dir, "..", "..");
const PROMPT_MESSAGES = discoverTeams(REPOSITORY_ROOT).flatMap((team) =>
  Object.values(team.entrypoints).map((entryPoint) => entryPoint.message),
);

// Words that exercise each dialect's special characters.
const AWKWARD_WORDS = [
  "Work issue #12",
  "it's done",
  "$HOME and `whoami` and $(id)",
  "",
  "line one\nline two",
  "a'b\"c\\d",
  "a,b",
  "@splat",
  "100%",
  "x;y",
  "C:\\Users\\me\\my repo",
];

// Runs a real shell on a command line that passes the quoted words to a program
// printing its arguments, and returns the arguments the program received.
function argumentsReceivedThroughShell(shellCommand: string[], quotedWords: string[]): string[] {
  const commandLine = [quoteBun(shellCommand), ...quotedWords].join(" ");
  const completedProcess = Bun.spawnSync([...shellCommand, commandLine]);
  const parsed: unknown = JSON.parse(completedProcess.stdout.toString());
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`unexpected output: ${completedProcess.stdout.toString()}`);
  }
  return parsed;
}

// The program part of the command line: `bun <script>`, quoted for the shell in use.
function quoteBun(shellCommand: string[]): string {
  if (shellCommand[0] === "bash") {
    return `bun ${quoteForPosixShell(PRINT_ARGUMENTS_SCRIPT)}`;
  }
  return `& bun ${quoteForPowerShell(PRINT_ARGUMENTS_SCRIPT)}`;
}

// The posix dialect is only rendered on Linux and macOS, where bash is always present.
describe.skipIf(process.platform === "win32")("quoteForPosixShell", () => {
  test("leaves flags, refs and paths unquoted", () => {
    expect(quoteForPosixShell("--worktree=app-issue-12")).toBe("--worktree=app-issue-12");
    expect(quoteForPosixShell("origin/feature/login")).toBe("origin/feature/login");
  });

  test("bash passes every awkward word through unchanged", () => {
    expect(
      argumentsReceivedThroughShell(["bash", "-c"], AWKWARD_WORDS.map(quoteForPosixShell)),
    ).toEqual(AWKWARD_WORDS);
  });

  // Catches a --print line that a user cannot paste back: one mis-quoted character in
  // a prompt would cut the message short or run part of it as a command.
  test("bash passes whole prompt messages through unchanged", () => {
    expect(
      argumentsReceivedThroughShell(["bash", "-c"], PROMPT_MESSAGES.map(quoteForPosixShell)),
    ).toEqual(PROMPT_MESSAGES);
  });
});

// PowerShell is rendered on Windows, but pwsh also runs on Linux and macOS. The CI
// runners for all three have it, so in CI a missing pwsh fails instead of skipping.
const powerShellPath = Bun.which("pwsh");
const powerShellRequired = process.env.CI === "true";
const POWERSHELL_TEST_TIMEOUT_MILLISECONDS = 30_000;

describe("quoteForPowerShell", () => {
  test("leaves flags and Windows paths unquoted", () => {
    expect(quoteForPowerShell("--worktree=app-issue-12")).toBe("--worktree=app-issue-12");
    expect(quoteForPowerShell("C:\\Users\\me\\repo")).toBe("C:\\Users\\me\\repo");
  });

  test("quotes commas and a leading @, which PowerShell would turn into arrays and splats", () => {
    expect(quoteForPowerShell("a,b")).toBe("'a,b'");
    expect(quoteForPowerShell("@splat")).toBe("'@splat'");
  });

  test.skipIf(powerShellPath === null && !powerShellRequired)(
    "pwsh passes every awkward word through unchanged",
    () => {
      expect(
        argumentsReceivedThroughShell(
          ["pwsh", "-NoProfile", "-NonInteractive", "-Command"],
          AWKWARD_WORDS.map(quoteForPowerShell),
        ),
      ).toEqual(AWKWARD_WORDS);
    },
    // PowerShell's cold start took over 5 s (bun's default limit) on the Linux CI runner.
    POWERSHELL_TEST_TIMEOUT_MILLISECONDS,
  );

  test.skipIf(powerShellPath === null && !powerShellRequired)(
    "pwsh passes whole prompt messages through unchanged",
    () => {
      expect(
        argumentsReceivedThroughShell(
          ["pwsh", "-NoProfile", "-NonInteractive", "-Command"],
          PROMPT_MESSAGES.map(quoteForPowerShell),
        ),
      ).toEqual(PROMPT_MESSAGES);
    },
    POWERSHELL_TEST_TIMEOUT_MILLISECONDS,
  );
});

describe("renderPlanAsShellCommand", () => {
  const plan = {
    preparationSteps: [],
    commandWords: ["docker", "agent", "run", "/teams/x/team.yaml", "Work issue #12"],
    workingDirectory: "/home/me/my app",
    pathEnvironment: "/teams/x/bin:/usr/bin",
  };

  test("posix: prepends only the team's directories to PATH and quotes words that need it", () => {
    expect(renderPlanAsShellCommand(plan, ["/teams/x/bin"], "posix")).toBe(
      `cd '/home/me/my app' && PATH=/teams/x/bin:"$PATH" docker agent run /teams/x/team.yaml 'Work issue #12'`,
    );
  });

  test("posix: omits the PATH assignment when the team adds no directories", () => {
    expect(renderPlanAsShellCommand(plan, [], "posix")).toBe(
      `cd '/home/me/my app' && docker agent run /teams/x/team.yaml 'Work issue #12'`,
    );
  });

  test("powershell: Set-Location, $env:Path prepended with ;, and & before the command", () => {
    const windowsPlan = {
      preparationSteps: [],
      commandWords: ["docker", "agent", "run", "C:\\teams\\x\\team.yaml", "Work issue #12"],
      workingDirectory: "C:\\Users\\me\\my app",
      pathEnvironment: "C:\\teams\\x\\bin;C:\\Windows",
    };
    expect(renderPlanAsShellCommand(windowsPlan, ["C:\\teams\\x\\bin"], "powershell")).toBe(
      `Set-Location -LiteralPath 'C:\\Users\\me\\my app'; $env:Path = 'C:\\teams\\x\\bin;' + $env:Path; & docker agent run C:\\teams\\x\\team.yaml 'Work issue #12'`,
    );
  });
});

describe("renderPlanAsShellCommand — worktree steps", () => {
  const planWithSteps = {
    preparationSteps: [
      ["git", "-C", "/code/my app", "fetch", "origin", "main"],
      [
        "git",
        "-C",
        "/code/my app",
        "worktree",
        "add",
        "-b",
        "worktree-x",
        "/code/x",
        "origin/main",
      ],
    ],
    commandWords: [
      "docker",
      "agent",
      "run",
      "/teams/x/team.yaml",
      "--working-dir",
      "/code/x",
      "Go",
    ],
    workingDirectory: "/code/x",
    pathEnvironment: "/teams/x/bin:/usr/bin",
  };

  test("posix: the git steps come first, each joined with &&", () => {
    expect(renderPlanAsShellCommand(planWithSteps, ["/teams/x/bin"], "posix")).toBe(
      `git -C '/code/my app' fetch origin main && git -C '/code/my app' worktree add -b worktree-x /code/x origin/main && cd /code/x && PATH=/teams/x/bin:"$PATH" docker agent run /teams/x/team.yaml --working-dir /code/x Go`,
    );
  });

  test("powershell: the launch is one script block, so && covers all of it", () => {
    expect(renderPlanAsShellCommand(planWithSteps, ["/teams/x/bin"], "powershell")).toBe(
      `& git -C '/code/my app' fetch origin main && & git -C '/code/my app' worktree add -b worktree-x /code/x origin/main && & { Set-Location -LiteralPath /code/x; $env:Path = '/teams/x/bin;' + $env:Path; & docker agent run /teams/x/team.yaml --working-dir /code/x Go }`,
    );
  });

  // A pasted --print line whose git step fails must not start the agent: in the wrong
  // directory it would work in the user's checkout. An invalid git option stands in for the failing
  // step, `echo` for docker.
  const failingPlan = {
    preparationSteps: [["git", "--no-such-option"]],
    commandWords: ["echo", "LAUNCHED"],
    workingDirectory: ".",
    pathEnvironment: "",
  };

  test.skipIf(process.platform === "win32")(
    "bash stops at a failed step and never launches",
    () => {
      const completedProcess = Bun.spawnSync([
        "bash",
        "-c",
        renderPlanAsShellCommand(failingPlan, [], "posix"),
      ]);
      expect(completedProcess.exitCode).not.toBe(0);
      expect(completedProcess.stdout.toString()).not.toContain("LAUNCHED");
    },
  );

  test.skipIf(powerShellPath === null && !powerShellRequired)(
    "pwsh stops at a failed step and never launches",
    () => {
      const completedProcess = Bun.spawnSync([
        "pwsh",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        renderPlanAsShellCommand(failingPlan, [], "powershell"),
      ]);
      expect(completedProcess.stdout.toString()).not.toContain("LAUNCHED");
    },
    POWERSHELL_TEST_TIMEOUT_MILLISECONDS,
  );
});

describe("shellDialectForPlatform", () => {
  test("uses PowerShell on Windows and POSIX syntax elsewhere", () => {
    expect(shellDialectForPlatform("win32")).toBe("powershell");
    expect(shellDialectForPlatform("darwin")).toBe("posix");
    expect(shellDialectForPlatform("linux")).toBe("posix");
  });
});
