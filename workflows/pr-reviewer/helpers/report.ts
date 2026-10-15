// Rules for the one report the reviewer may post. Side-effect free so tests can import it.
// The report is model-written from untrusted PR content and the comment may be read by
// everyone with access to the repository, so these checks run before anything is posted.

import { HelperUsageError } from "../../../launcher/src/team-helper.ts";
import { OBJECT_ID } from "./snapshot.ts";

/** Under GitHub's 65,536-character limit, and under Windows' per-variable environment limit. */
export const MAX_COMMENT_CHARACTERS = 30_000;

const REPORT_HEADER = /^VERDICT: (?:Ship it|Approve-with-nits|Needs work)\r?\n/;
const REVIEWED_HEAD_LINE = /^Reviewed head SHA: (\S+)\s*$/m;

/**
 * Best-effort credential shapes. A match blocks posting; no match is not proof the
 * report is clean, so the reviewer instructions also forbid quoting secrets.
 */
const CREDENTIAL_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "Anthropic or OpenAI API key", pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
  {
    name: "GitHub token",
    pattern: /\b(?:gh[opusr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/,
  },
  { name: "AWS access key ID", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  {
    name: "JSON web token",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
];

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
  const reviewedHead = REVIEWED_HEAD_LINE.exec(report)?.[1];
  if (reviewedHead === undefined || !OBJECT_ID.safeParse(reviewedHead).success) {
    throw new Error(
      "the report must contain a 'Reviewed head SHA: <full commit ID>' line. Nothing was posted.",
    );
  }
  for (const { name, pattern } of CREDENTIAL_PATTERNS) {
    if (pattern.test(report)) {
      throw new Error(
        `the report appears to contain a ${name}. Remove it, describe the problem without quoting the secret, and call pr_comment again. Nothing was posted.`,
      );
    }
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
