// test-quality-change-diff: prints the current branch's change since it left the
// remote default branch, then any uncommitted or untracked work (see
// launcher/src/change-diff.ts). Always the full change: review-branch has no
// "last reviewed" commit to narrow it to.

import { formatChangeDiff } from "../../../launcher/src/change-diff.ts";
import { runHelper } from "../../../launcher/src/team-helper.ts";

runHelper("test-quality-change-diff", () => {
  process.stdout.write(formatChangeDiff(undefined));
});
