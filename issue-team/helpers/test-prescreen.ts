// issue-team-test-prescreen: runs the j5-test-quality Tier 1 pre-screen in strict mode
// on the test files changed since this branch left the remote default branch,
// including uncommitted changes and new files registered with `git add -N`.
// Exit 0 = no HIGH findings; 1 = HIGH findings; 2 = the pre-screen could not run.
//
// Runs this repository's copy of the script (skills/j5-test-quality), not the one
// the installer copied to ~/.agents/skills, so the team and its pre-screen always
// come from the same checkout.

import { join } from "node:path";

import { resolveDefaultBranchRef } from "../../launcher/src/git.ts";
import { runAndCapture, runHelper } from "./command.ts";

const PRESCREEN_SCRIPT_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "skills",
  "j5-test-quality",
  "scripts",
  "check-test-quality.ts",
);

runHelper("issue-team-test-prescreen", () => {
  const baseRef = resolveDefaultBranchRef(process.cwd());
  const mergeBase = runAndCapture(["git", "merge-base", "HEAD", baseRef]).trim();
  // A single commit as the range compares it with the working tree, so uncommitted
  // and intent-to-add test files are included.
  const completedProcess = Bun.spawnSync(
    [process.execPath, PRESCREEN_SCRIPT_PATH, "--strict", "--diff", mergeBase],
    { stdout: "inherit", stderr: "inherit" },
  );
  process.exit(completedProcess.exitCode);
});
