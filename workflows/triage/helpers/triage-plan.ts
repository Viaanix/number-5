// The rules of the triage team as plain functions: the four verdicts and their labels, the limits
// on what one run may write, how a comment and its sub-issues are built, and what to do when an
// issue was already triaged. Nothing here talks to GitHub, so tests import it directly;
// helpers/apply.ts does the writing.
//
// The limits are enforced here, in code, and not left to the prompt: the text the agent works from
// is written by other people, so what it may do to GitHub must not depend on it staying on task.

import { z } from "zod";

import { findCredentialShape } from "#launcher/credential-shapes.ts";
import { HelperUsageError } from "#launcher/team-helper.ts";

export const VERDICTS = ["ready", "needs-info", "needs-decision", "split"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Every label this team applies starts with this, so none can collide with a repo's own labels. */
export const LABEL_PREFIX = "j5/";

export const VERDICT_LABELS: Record<Verdict, { name: string; color: string; description: string }> =
  {
    ready: {
      name: "j5/ready",
      color: "0e8a16",
      description: "Triage: enough information to work on, and small enough for one pull request",
    },
    "needs-info": {
      name: "j5/needs-info",
      color: "fbca04",
      description: "Triage: the reporter has to answer specific questions before work can start",
    },
    "needs-decision": {
      name: "j5/needs-decision",
      color: "d93f0b",
      description: "Triage: a maintainer has to make a decision before work can start",
    },
    split: {
      name: "j5/split",
      color: "5319e7",
      description: "Triage: too large for one pull request; split into sub-issues",
    },
  };

// Tool arguments travel as environment variables, and Windows allows 32,767 characters in one,
// so the limits below keep every argument well under that and under GitHub's own limits.
export const MAX_COMMENT_CHARACTERS = 20_000;
export const MAX_CHILDREN_JSON_CHARACTERS = 30_000;
export const MIN_CHILDREN = 2;
export const MAX_CHILDREN = 8;
export const MAX_CHILD_TITLE_CHARACTERS = 200;
export const MAX_CHILD_BODY_CHARACTERS = 3_000;

const ISSUE_NUMBER_PATTERN = /^[1-9][0-9]*$/;
const TRIAGE_MARKER_PATTERN = /<!-- j5-triage verdict=(ready|needs-info|needs-decision|split) -->/;

export type ChildIssue = { title: string; body: string };

const childrenSchema = z.array(z.strictObject({ title: z.string(), body: z.string() }));

export function parseIssueNumber(rawIssue: string | undefined): number {
  if (rawIssue === undefined || !ISSUE_NUMBER_PATTERN.test(rawIssue)) {
    throw new HelperUsageError(
      "issue must be a positive issue number (usage: issue=<n> verdict=<verdict> comment=<text>)",
    );
  }
  return Number(rawIssue);
}

export function parseVerdict(rawVerdict: string | undefined): Verdict {
  const verdict = VERDICTS.find((candidate) => candidate === rawVerdict);
  if (verdict === undefined) {
    throw new HelperUsageError(
      `verdict must be one of ${VERDICTS.join(", ")}; got '${rawVerdict ?? ""}'. Nothing was written.`,
    );
  }
  return verdict;
}

/** The comment the agent wrote: present, within the limit, and free of credential shapes. */
export function requireCommentText(rawComment: string | undefined): string {
  const comment = (rawComment ?? "").trim();
  if (comment === "") {
    throw new HelperUsageError(
      "comment must be the triage comment text (usage: issue=<n> verdict=<verdict> comment=<text>). Nothing was written.",
    );
  }
  if (comment.length > MAX_COMMENT_CHARACTERS) {
    throw new Error(
      `the comment is ${comment.length} characters; the limit is ${MAX_COMMENT_CHARACTERS}. Shorten it and call triage_apply again. Nothing was written.`,
    );
  }
  const credentialShape = findCredentialShape(comment);
  if (credentialShape !== undefined) {
    throw new Error(
      `the comment appears to contain a ${credentialShape}. Remove it, describe the problem without quoting the secret, and call triage_apply again. Nothing was written.`,
    );
  }
  return comment;
}

function requireChildText(position: number, field: "title" | "body", text: string): string {
  const limit = field === "title" ? MAX_CHILD_TITLE_CHARACTERS : MAX_CHILD_BODY_CHARACTERS;
  if (text === "") {
    throw new Error(`child ${position} has an empty ${field}. Nothing was written.`);
  }
  if (text.length > limit) {
    throw new Error(
      `child ${position}'s ${field} is ${text.length} characters; the limit is ${limit}. Nothing was written.`,
    );
  }
  if (field === "title" && /[\r\n]/.test(text)) {
    throw new Error(`child ${position}'s title must be one line. Nothing was written.`);
  }
  const credentialShape = findCredentialShape(text);
  if (credentialShape !== undefined) {
    throw new Error(
      `child ${position}'s ${field} appears to contain a ${credentialShape}. Remove it and call triage_apply again. Nothing was written.`,
    );
  }
  return text;
}

/**
 * The sub-issues to create. Only the split verdict has any, and it needs between MIN_CHILDREN and
 * MAX_CHILDREN: one child is a rename, and an unbounded number is how a confused run floods a
 * tracker.
 */
export function parseChildren(rawChildren: string | undefined, verdict: Verdict): ChildIssue[] {
  const given = rawChildren !== undefined && rawChildren.trim() !== "";
  if (verdict !== "split") {
    if (given) {
      throw new HelperUsageError(
        `children is only for the split verdict, and this call says ${verdict}. Nothing was written.`,
      );
    }
    return [];
  }
  if (!given) {
    throw new HelperUsageError(
      `the split verdict needs children: a JSON array of ${MIN_CHILDREN} to ${MAX_CHILDREN} {"title", "body"} objects. Nothing was written.`,
    );
  }
  if (rawChildren.length > MAX_CHILDREN_JSON_CHARACTERS) {
    throw new Error(
      `children is ${rawChildren.length} characters; the limit is ${MAX_CHILDREN_JSON_CHARACTERS}. Shorten the bodies and call triage_apply again. Nothing was written.`,
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawChildren);
  } catch {
    throw new HelperUsageError(
      'children is not valid JSON; it must be an array of {"title", "body"} objects. Nothing was written.',
    );
  }
  const parsed = childrenSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new HelperUsageError(
      `children must be an array of {"title": string, "body": string} objects and nothing else. Nothing was written.`,
    );
  }
  if (parsed.data.length < MIN_CHILDREN || parsed.data.length > MAX_CHILDREN) {
    throw new Error(
      `a split needs ${MIN_CHILDREN} to ${MAX_CHILDREN} children; this call has ${parsed.data.length}. Nothing was written.`,
    );
  }
  const children = parsed.data.map((child, index) => ({
    title: requireChildText(index + 1, "title", child.title.trim()),
    body: requireChildText(index + 1, "body", child.body.trim()),
  }));
  const seenTitles = new Set<string>();
  for (const child of children) {
    const titleKey = child.title.toLowerCase();
    if (seenTitles.has(titleKey)) {
      throw new Error(
        `two children are titled '${child.title}'. Give each its own title. Nothing was written.`,
      );
    }
    seenTitles.add(titleKey);
  }
  return children;
}

export function triageMarker(verdict: Verdict): string {
  return `<!-- j5-triage verdict=${verdict} -->`;
}

/** The verdict a triage comment records, or undefined when the comment is not one. */
export function markerVerdict(commentBody: string): Verdict | undefined {
  const matchedVerdict = TRIAGE_MARKER_PATTERN.exec(commentBody)?.[1];
  return VERDICTS.find((candidate) => candidate === matchedVerdict);
}

/** The comment as posted: a hidden marker for repeat detection, the text, the children, a footer. */
export function buildTriageComment(
  verdict: Verdict,
  comment: string,
  createdChildren: Array<{ number: number; title: string }>,
): string {
  const childList =
    createdChildren.length === 0
      ? ""
      : `\n\n**Sub-issues**\n${createdChildren.map((child) => `- #${child.number} ${child.title}`).join("\n")}`;
  return `${triageMarker(verdict)}\n${comment}${childList}\n\n---\n_Triaged by the j5 triage agent from the issue text and a read-only look at the code. Nothing was built or run. Verdict: \`${VERDICT_LABELS[verdict].name}\`._\n`;
}

/** The body of a child issue: what the agent wrote, then where it came from. */
export function buildChildBody(parentNumber: number, body: string): string {
  return `${body}\n\n---\nPart of #${parentNumber}. Created by the j5 triage agent when it split that issue.\n`;
}

/** A child inherits the parent's own labels (type, area) and is marked ready; none of the parent's verdicts. */
export function labelsForChild(parentLabelNames: string[]): string[] {
  return [
    ...parentLabelNames.filter((name) => !name.startsWith(LABEL_PREFIX)),
    VERDICT_LABELS.ready.name,
  ];
}

/** What to add and remove so the issue carries this verdict's label and no other verdict's. */
export function planLabelChange(
  currentLabelNames: string[],
  verdict: Verdict,
): { add: string[]; remove: string[] } {
  const targetLabel = VERDICT_LABELS[verdict].name;
  const verdictLabelNames = new Set(Object.values(VERDICT_LABELS).map((label) => label.name));
  return {
    add: currentLabelNames.includes(targetLabel) ? [] : [targetLabel],
    remove: currentLabelNames.filter((name) => verdictLabelNames.has(name) && name !== targetLabel),
  };
}

export type RepeatDecision =
  | { kind: "apply" }
  | { kind: "skip"; reason: string }
  | { kind: "refuse"; reason: string };

/**
 * Decides whether this verdict is worth writing to an issue that may already have been triaged.
 * Re-running a queue must not post the same comment twice, and splitting twice would create a
 * second set of children.
 */
export function decideRepeat(
  issue: { labelNames: string[]; commentBodies: string[]; subIssueCount: number },
  verdict: Verdict,
): RepeatDecision {
  if (verdict === "split" && issue.subIssueCount > 0) {
    return {
      kind: "refuse",
      reason: `the issue already has ${issue.subIssueCount} sub-issue(s), so it is not split again. If it still needs work, use needs-decision and say why. Nothing was written.`,
    };
  }
  const lastCommentIndex = issue.commentBodies.length - 1;
  const lastMarkerIndex = issue.commentBodies.findLastIndex(
    (body) => markerVerdict(body) !== undefined,
  );
  const lastCommentIsSameVerdict =
    lastMarkerIndex === lastCommentIndex &&
    lastMarkerIndex >= 0 &&
    markerVerdict(issue.commentBodies[lastMarkerIndex] ?? "") === verdict;
  if (lastCommentIsSameVerdict && issue.labelNames.includes(VERDICT_LABELS[verdict].name)) {
    return {
      kind: "skip",
      reason: `the issue was already triaged as ${VERDICT_LABELS[verdict].name} and nobody has commented since, so there is nothing new to say`,
    };
  }
  return { kind: "apply" };
}
