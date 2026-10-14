// The per-OS entry points the alias and installer point at: bin/j5 (POSIX shell)
// and bin/j5.cmd (Windows). Each must reach the launcher and find the teams.

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..");
const RUNNING_ON_WINDOWS = process.platform === "win32";

type EntryPointResult = { exitCode: number; standardOutput: string; standardError: string };

function runEntryPoint(commandWords: string[]): EntryPointResult {
  const completedProcess = Bun.spawnSync(commandWords, { stdin: "ignore" });
  return {
    exitCode: completedProcess.exitCode,
    standardOutput: completedProcess.stdout.toString(),
    standardError: completedProcess.stderr.toString(),
  };
}

describe("entry points", () => {
  test.skipIf(RUNNING_ON_WINDOWS)("bin/j5 runs the launcher (POSIX)", () => {
    const result = runEntryPoint([join(REPOSITORY_ROOT, "bin", "j5"), "list"]);
    // Compared together so a failure shows the entry point's error output.
    expect({ exitCode: result.exitCode, standardError: result.standardError }).toEqual({
      exitCode: 0,
      standardError: "",
    });
    expect(result.standardOutput).toContain("issue-team — ");
  });

  // Spawned directly, as the launch test in cli.test.ts spawns a .cmd successfully.
  // An earlier version wrapped it in `cmd /d /s /c "..."` and exited 1 on Windows CI
  // without its stderr being captured; the cause was not established.
  test.skipIf(!RUNNING_ON_WINDOWS)("bin\\j5.cmd runs the launcher (Windows)", () => {
    const result = runEntryPoint([join(REPOSITORY_ROOT, "bin", "j5.cmd"), "list"]);
    expect({ exitCode: result.exitCode, standardError: result.standardError }).toEqual({
      exitCode: 0,
      standardError: "",
    });
    expect(result.standardOutput).toContain("issue-team — ");
  });
});
