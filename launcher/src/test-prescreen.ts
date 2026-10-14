// Runs the j5-test-quality Tier 1 pre-screen in strict mode, for every team's
// test-prescreen helper (workflows/<team>/helpers/). Two scopes:
//   - changes: test files changed since the current branch left the remote default
//     branch, including uncommitted changes and new files registered with `git add -N`;
//   - a path: every test file under that file or directory.
// Exit 0 = no HIGH findings; 1 = HIGH findings; 2 = the pre-screen could not run.
//
// Runs this repository's copy of the script (skills/j5-test-quality), not the one
// the installer copied to ~/.agents/skills, so a team and its pre-screen always
// come from the same checkout.

import { join } from "node:path";

import { resolveDefaultBranchRef } from "./git.ts";
import { runAndCapture } from "./team-helper.ts";

// launcher/src/ → launcher/ → the repository root.
const PRESCREEN_SCRIPT_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "skills",
  "j5-test-quality",
  "scripts",
  "check-test-quality.ts",
);

/** What the pre-screen scans: the branch's changed test files, or one path. */
export type PrescreenScope = { kind: "changes" } | { kind: "path"; path: string };

/**
 * Runs the pre-screen in the current directory with its output going straight to
 * this process's stdout and stderr, and returns the pre-screen's exit code.
 * @throws Error when the changes scope cannot find the default branch or merge base.
 */
export function runTestPrescreen(scope: PrescreenScope): number {
  const scopeArguments: string[] = [];
  if (scope.kind === "path") {
    scopeArguments.push(scope.path);
  } else {
    const baseRef = resolveDefaultBranchRef(process.cwd());
    const mergeBase = runAndCapture(["git", "merge-base", "HEAD", baseRef]).trim();
    // A single commit as the range compares it with the working tree, so uncommitted
    // and intent-to-add test files are included.
    scopeArguments.push("--diff", mergeBase);
  }
  const completedProcess = Bun.spawnSync(
    [process.execPath, PRESCREEN_SCRIPT_PATH, "--strict", ...scopeArguments],
    { stdout: "inherit", stderr: "inherit" },
  );
  return completedProcess.exitCode;
}
