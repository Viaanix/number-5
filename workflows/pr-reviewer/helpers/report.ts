// Rules for the one report the reviewer may post. Side-effect free so tests can import it.
// The report is model-written from untrusted PR content and the comment may be read by
// everyone with access to the repository, so these checks run before anything is posted.

import { findCredentialShape } from "#launcher/credential-shapes.ts";
import { reviewedHeadOfComment } from "#launcher/review-status.ts";
import { HelperUsageError } from "#launcher/team-helper.ts";

import { OBJECT_ID } from "./snapshot.ts";

/** Under GitHub's 65,536-character limit, and under Windows' per-variable environment limit. */
export const MAX_COMMENT_CHARACTERS = 30_000;

const REPORT_HEADER = /^VERDICT: (?:Ship it|Approve-with-nits|Needs work)\r?\n/;
// The stamp line is shared (launcher/src/review-status.ts) with the queue that selects pull requests
// by it, so the line posted here is exactly the one that marks a pull request reviewed.

// The credential shapes are shared (launcher/src/credential-shapes.ts) with the other teams that
// post model-written text.
/** Returns the head SHA the report says it reviewed, or throws why it is not postable. */
export function requirePostableReport(report: string): string {
  if (report.trim() === "") {
    throw new HelperUsageError(
      "body must be the finished review report (usage: body=<report> pr=<n>)",
    );
  }
  if (report.length > MAX_COMMENT_CHARACTERS) {
    throw new Error(
      `report is ${report.length} characters; the limit is ${MAX_COMMENT_CHARACTERS}. Shorten the report (fewer, tighter findings) and call pr_comment again. Nothing was posted.`,
    );
  }
  if (!REPORT_HEADER.test(report)) {
    throw new Error(
      "only a finished review report is posted: it must start with a 'VERDICT: Ship it | Approve-with-nits | Needs work' line. A BLOCKED result is never posted. Nothing was posted.",
    );
  }
  const reviewedHead = reviewedHeadOfComment(report);
  if (reviewedHead === undefined || !OBJECT_ID.safeParse(reviewedHead).success) {
    throw new Error(
      "the report must contain a 'Reviewed head SHA: <full commit ID>' line. Nothing was posted.",
    );
  }
  const credentialShape = findCredentialShape(report);
  if (credentialShape !== undefined) {
    throw new Error(
      `the report appears to contain a ${credentialShape}. Remove it, describe the problem without quoting the secret, and call pr_comment again. Nothing was posted.`,
    );
  }
  return reviewedHead;
}

/**
 * Removes the reviewer's local-only "Comment posted/not posted" lines. The posted text
 * cannot know the comment's URL, and a model that writes the line early invents one.
 */
export function stripLocalStatusLines(report: string): string {
  return report.replace(/^Comment (?:not )?posted:.*(?:\r?\n|$)/gm, "");
}
