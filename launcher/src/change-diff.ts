// The change under review, as one text block: the commits on the current branch
// since it left the remote default branch with their full diff, then any
// uncommitted or untracked work. With `since` (the last reviewed HEAD), the commits
// added after it come first as the review scope, and the full change follows as
// context. Shared by every team's change-diff helper (workflows/<team>/helpers/),
// which docker-agent's change_diff script tools call in the project checkout.

import { resolveDefaultBranchRef } from "./git.ts";
import { runAndCapture, succeeds } from "./team-helper.ts";

// An abbreviated or full commit SHA.
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/;

/**
 * Builds the change report for the repository in the current directory.
 * A `since` that is not a commit in HEAD's history falls back to the full change,
 * and the first line says so.
 * @throws Error when the default branch cannot be found or a git command fails.
 */
export function formatChangeDiff(requestedSince: string | undefined): string {
  const output: string[] = [];
  const write = (text: string): void => {
    output.push(text);
  };

  const baseRef = resolveDefaultBranchRef(process.cwd());
  const mergeBase = runAndCapture(["git", "merge-base", "HEAD", baseRef]).trim();
  let since = requestedSince;

  if (
    since !== undefined &&
    (!COMMIT_SHA_PATTERN.test(since) ||
      !succeeds(["git", "merge-base", "--is-ancestor", since, "HEAD"]))
  ) {
    write(
      `scope: full (since '${since}' is not a commit in this branch's history, e.g. after a rebase or force-push)\n`,
    );
    since = undefined;
  } else if (since !== undefined) {
    write(`scope: new-commits since ${since}\n`);
  } else {
    write("scope: full\n");
  }
  write(`base: ${baseRef}  merge-base: ${mergeBase}\n`);

  if (since !== undefined) {
    write("\n## New commits (review scope)\n");
    write(runAndCapture(["git", "log", "--oneline", `${since}..HEAD`]));
    write("\n");
    write(runAndCapture(["git", "diff", since, "HEAD"]));
    write("\n## Full change (context only)\n");
  }

  write("\n## Commits\n");
  write(runAndCapture(["git", "log", "--oneline", `${mergeBase}..HEAD`]));
  write("\n## Files\n");
  write(runAndCapture(["git", "diff", "--stat", mergeBase, "HEAD"]));
  write("\n## Diff\n");
  write(runAndCapture(["git", "diff", mergeBase, "HEAD"]));

  const uncommitted = runAndCapture(["git", "status", "--porcelain"]).replace(/\n+$/, "");
  if (uncommitted !== "") {
    write(
      `\n## Uncommitted work (not in the commits above; read ?? files directly)\n${uncommitted}\n\n`,
    );
    write(runAndCapture(["git", "diff", "HEAD"]));
  }

  return output.join("");
}
