import { describe, expect, test } from "bun:test";

import { quoteForShell, renderPlanAsShellCommand } from "../src/shell-quote.ts";

// Runs the quoted word through a real bash and returns what bash hands to printf,
// so the tests check quoting against the shell rather than against our own idea of it.
function roundTripThroughBash(word: string): string {
  const completedProcess = Bun.spawnSync(["bash", "-c", `printf %s ${quoteForShell(word)}`]);
  return completedProcess.stdout.toString();
}

describe("quoteForShell", () => {
  test("leaves flags, refs and paths unquoted", () => {
    expect(quoteForShell("--worktree=app-issue-12")).toBe("--worktree=app-issue-12");
    expect(quoteForShell("origin/feature/login")).toBe("origin/feature/login");
  });

  test.each([
    "Work issue #12",
    "it's done",
    "$HOME and `whoami` and $(id)",
    "",
    "line one\nline two",
    "a'b\"c\\d",
  ])("bash reads the quoted form of %p back unchanged", (word) => {
    expect(roundTripThroughBash(word)).toBe(word);
  });
});

describe("renderPlanAsShellCommand", () => {
  const plan = {
    commandWords: ["docker", "agent", "run", "/teams/x/team.yaml", "Work issue #12"],
    workingDirectory: "/home/me/my app",
    pathEnvironment: "/teams/x/bin:/usr/bin",
  };

  test("prepends only the team's directories to PATH and quotes words that need it", () => {
    expect(renderPlanAsShellCommand(plan, ["/teams/x/bin"])).toBe(
      `cd '/home/me/my app' && PATH=/teams/x/bin:"$PATH" docker agent run /teams/x/team.yaml 'Work issue #12'`,
    );
  });

  test("omits the PATH assignment when the team adds no directories", () => {
    expect(renderPlanAsShellCommand(plan, [])).toBe(
      `cd '/home/me/my app' && docker agent run /teams/x/team.yaml 'Work issue #12'`,
    );
  });
});
