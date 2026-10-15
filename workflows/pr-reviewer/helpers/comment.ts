// Posts the reviewer's finished report as one comment on the verified PR. This is the
// reviewer's only GitHub write: a plain comment, never an approval or change request.

import { runHelper } from "../../../launcher/src/team-helper.ts";
import { requirePostableReport, stripLocalStatusLines } from "./report.ts";
import { parsePullRequestNumber, readSnapshot, verifyCheckout } from "./snapshot.ts";

const FOOTER =
  "\n\n---\n_Static review by the j5 pr-reviewer agent. Nothing was built or run, and CI results above are reported claims, not verified by this review._\n";

runHelper("pr-reviewer-comment", () => {
  const pullRequestNumber = parsePullRequestNumber();
  const report = stripLocalStatusLines(process.env.body ?? "");
  const reviewedHead = requirePostableReport(report);
  const snapshot = readSnapshot(pullRequestNumber);
  verifyCheckout(snapshot.headRefOid);
  if (reviewedHead !== snapshot.headRefOid) {
    throw new Error(
      `the report reviewed ${reviewedHead}, but PR ${pullRequestNumber} is now at ${snapshot.headRefOid}. A comment about an old commit is not posted. Nothing was posted; re-run the review.`,
    );
  }
  const githubCli = Bun.which("gh") ?? "gh";
  const completedProcess = Bun.spawnSync(
    [githubCli, "pr", "comment", pullRequestNumber, "--body-file", "-"],
    { stdin: Buffer.from(`${report.trimEnd()}${FOOTER}`), stdout: "pipe", stderr: "pipe" },
  );
  if (completedProcess.exitCode !== 0) {
    throw new Error(
      `gh pr comment failed (exit ${completedProcess.exitCode}): ${completedProcess.stderr.toString().trim()}. The comment may not have been posted; do not retry with different content or another method.`,
    );
  }
  console.log(
    `Posted comment on PR ${pullRequestNumber}: ${completedProcess.stdout.toString().trim()}`,
  );
});
