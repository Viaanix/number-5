// issue-team-base-ref: prints the remote default branch as a remote-tracking ref
// (e.g. origin/main), from origin/HEAD or, when a clone never set it, from GitHub.

import { resolveDefaultBranchRef } from "#launcher/git.ts";
import { runHelper } from "#launcher/team-helper.ts";

runHelper("issue-team-base-ref", () => {
  console.log(resolveDefaultBranchRef(process.cwd()));
});
