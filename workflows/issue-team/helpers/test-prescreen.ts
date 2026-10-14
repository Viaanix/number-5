// issue-team-test-prescreen: runs the j5-test-quality Tier 1 pre-screen in strict mode
// on the test files changed since this branch left the remote default branch,
// including uncommitted changes and new files registered with `git add -N`
// (see launcher/src/test-prescreen.ts).
// Exit 0 = no HIGH findings; 1 = HIGH findings; 2 = the pre-screen could not run.

import { runHelper } from "../../../launcher/src/team-helper.ts";
import { runTestPrescreen } from "../../../launcher/src/test-prescreen.ts";

runHelper("issue-team-test-prescreen", () => {
  process.exit(runTestPrescreen({ kind: "changes" }));
});
