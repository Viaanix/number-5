// The per-OS entry points the alias and installer point at: bin/daw (POSIX shell)
// and bin/daw.cmd (Windows). Each must reach the launcher and find the teams.

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..");
const RUNNING_ON_WINDOWS = process.platform === "win32";

function runEntryPoint(commandWords: string[]): { exitCode: number; standardOutput: string } {
  const completedProcess = Bun.spawnSync(commandWords, { stdin: "ignore" });
  return {
    exitCode: completedProcess.exitCode,
    standardOutput: completedProcess.stdout.toString(),
  };
}

describe("entry points", () => {
  test.skipIf(RUNNING_ON_WINDOWS)("bin/daw runs the launcher (POSIX)", () => {
    const result = runEntryPoint([join(REPOSITORY_ROOT, "bin", "daw"), "list"]);
    expect(result.exitCode).toBe(0);
    expect(result.standardOutput).toContain("issue-team — ");
  });

  // cmd.exe runs batch files; /d skips AutoRun commands, /s /c runs the line as given.
  test.skipIf(!RUNNING_ON_WINDOWS)("bin\\daw.cmd runs the launcher (Windows)", () => {
    const result = runEntryPoint([
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      `"${join(REPOSITORY_ROOT, "bin", "daw.cmd")}" list`,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.standardOutput).toContain("issue-team — ");
  });
});
