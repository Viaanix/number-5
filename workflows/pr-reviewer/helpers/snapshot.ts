// Shared, side-effect-free logic for the PR reviewer's helpers: verified PR snapshot,
// the deterministic diff stream, and its pagination. docker-agent truncates any tool
// result over 51200 bytes to its tail, which drops the OIDs at the start; so nothing
// here may produce one unbounded result. Never refresh or repair the checkout.

import { createHash } from "node:crypto";

import { z } from "zod";

import {
  HelperUsageError,
  readToolArgument,
  runAndCapture,
} from "../../../launcher/src/team-helper.ts";

/** docker-agent's tool-result limit is 51200 bytes; leave room for page framing. */
export const PAGE_CONTENT_BYTE_LIMIT = 40_000;

export const OBJECT_ID = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

const SNAPSHOT_FIELDS = ["number", "baseRefOid", "headRefOid"];
const snapshotSchema = z.object({
  number: z.number().int().positive(),
  baseRefOid: OBJECT_ID,
  headRefOid: OBJECT_ID,
});

const OVERVIEW_FIELDS = [
  ...SNAPSHOT_FIELDS,
  "title",
  "body",
  "url",
  "state",
  "baseRefName",
  "headRefName",
  "statusCheckRollup",
  "closingIssuesReferences",
];
const overviewSchema = snapshotSchema.extend({
  title: z.string(),
  body: z.string(),
  url: z.url(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  baseRefName: z.string().min(1),
  headRefName: z.string().min(1),
  statusCheckRollup: z.array(z.looseObject({})).nullable(),
  closingIssuesReferences: z.array(z.looseObject({})),
});

/** Reported CI claims are clipped: they are untrusted claims, not review evidence. */
const MAX_REPORTED_ITEMS = 50;
const REPORTED_CHECK_FIELDS = [
  "__typename",
  "name",
  "workflowName",
  "context",
  "status",
  "state",
  "conclusion",
] as const;
/** The body is untrusted text and can be arbitrarily large; the diff is the evidence. */
export const MAX_BODY_BYTES = 10_000;

export type Snapshot = z.infer<typeof snapshotSchema>;
export type Overview = z.infer<typeof overviewSchema>;

export interface DiffStream {
  mergeBaseOid: string;
  changedPathCount: number;
  /** Changed paths, diff stat and the full diff as one deterministic text. */
  text: string;
}

function git(...arguments_: string[]): string {
  // Even read-only status can otherwise execute a repository-configured fsmonitor hook.
  return runAndCapture(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", ...arguments_]);
}

export function parsePullRequestNumber(): string {
  const argument = readToolArgument("pr");
  if (
    argument === undefined ||
    !/^[1-9][0-9]*$/.test(argument) ||
    !Number.isSafeInteger(Number(argument))
  ) {
    throw new HelperUsageError("pr must be a positive safe integer (usage: <helper> <pr>)");
  }
  return argument;
}

function readPullRequestJson(pullRequestNumber: string, fields: string[]): unknown {
  return JSON.parse(
    runAndCapture(["gh", "pr", "view", pullRequestNumber, "--json", fields.join(",")]),
  ) as unknown;
}

function requireRequestedNumber(returnedNumber: number, pullRequestNumber: string): void {
  if (returnedNumber !== Number(pullRequestNumber)) {
    throw new Error(
      `GitHub returned PR ${returnedNumber} instead of requested PR ${pullRequestNumber}.`,
    );
  }
}

export function readSnapshot(pullRequestNumber: string): Snapshot {
  const snapshot = snapshotSchema.parse(readPullRequestJson(pullRequestNumber, SNAPSHOT_FIELDS));
  requireRequestedNumber(snapshot.number, pullRequestNumber);
  return snapshot;
}

export function readOverview(pullRequestNumber: string): Overview {
  const overview = overviewSchema.parse(readPullRequestJson(pullRequestNumber, OVERVIEW_FIELDS));
  requireRequestedNumber(overview.number, pullRequestNumber);
  return overview;
}

export function verifyCheckout(expectedHeadOid: string): void {
  const headOid = git("rev-parse", "--verify", "HEAD").trim();
  if (headOid !== expectedHeadOid) {
    throw new Error(
      `checkout HEAD ${headOid} does not match PR head ${expectedHeadOid}. Refresh the PR worktree to the current PR head outside this reviewer, then retry. No checkout changes were made.`,
    );
  }
  if (
    git("status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none") !==
    ""
  ) {
    throw new Error(
      "checkout has tracked or untracked changes. Commit, move, or remove them outside this reviewer, then retry with a clean PR worktree. No checkout changes were made.",
    );
  }
}

/** Builds the stream for a PR whose checkout was just verified. */
export function buildDiffStream(snapshot: Snapshot): DiffStream {
  let mergeBaseOid: string;
  try {
    mergeBaseOid = OBJECT_ID.parse(git("merge-base", snapshot.baseRefOid, "HEAD").trim());
  } catch {
    throw new Error(
      `merge-base for PR base ${snapshot.baseRefOid} and HEAD is unavailable. Fetch the PR base/head history outside this reviewer, then retry. No fetch or checkout changes were made.`,
    );
  }
  const commonArguments = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-relative",
    "--find-renames",
  ];
  const changedPaths = git(...commonArguments, "--name-only", "-z", mergeBaseOid, "HEAD", "--")
    .split("\0")
    .filter((path) => path !== "");
  // No --unified here: any patch-implying option makes --stat print the whole diff too.
  const stat = git(...commonArguments, "--stat", mergeBaseOid, "HEAD", "--");
  const diff = git(...commonArguments, "--unified=5", mergeBaseOid, "HEAD", "--");
  return {
    mergeBaseOid,
    changedPathCount: changedPaths.length,
    text: `CHANGED PATHS\n${changedPaths.join("\n")}\nDIFF STAT\n${stat}DIFF\n${diff}`,
  };
}

/**
 * Splits text into pages of at most maxBytes UTF-8 bytes, preferring line boundaries.
 * A single line over the limit is split between code points. Concatenating the pages
 * in order reproduces the text exactly.
 */
export function paginate(text: string, maxBytes: number): string[] {
  const pages: string[] = [];
  let current = "";
  let currentBytes = 0;
  const flush = (): void => {
    if (current !== "") {
      pages.push(current);
      current = "";
      currentBytes = 0;
    }
  };
  for (const line of text.split(/(?<=\n)/)) {
    const lineBytes = Buffer.byteLength(line);
    if (lineBytes <= maxBytes) {
      if (currentBytes + lineBytes > maxBytes) {
        flush();
      }
      current += line;
      currentBytes += lineBytes;
      continue;
    }
    flush();
    for (const codePoint of line) {
      const codePointBytes = Buffer.byteLength(codePoint);
      if (currentBytes + codePointBytes > maxBytes) {
        flush();
      }
      current += codePoint;
      currentBytes += codePointBytes;
    }
  }
  flush();
  return pages.length === 0 ? [""] : pages;
}

export function fingerprint(text: string): { sha256: string; bytes: number } {
  return {
    sha256: createHash("sha256").update(text).digest("hex"),
    bytes: Buffer.byteLength(text),
  };
}

/** Keeps the first maxBytes of a string without splitting a code point. */
export function clipToBytes(
  text: string,
  maxBytes: number,
): { text: string; omittedBytes: number } {
  const totalBytes = Buffer.byteLength(text);
  if (totalBytes <= maxBytes) {
    return { text, omittedBytes: 0 };
  }
  let clipped = "";
  let clippedBytes = 0;
  for (const codePoint of text) {
    const codePointBytes = Buffer.byteLength(codePoint);
    if (clippedBytes + codePointBytes > maxBytes) {
      break;
    }
    clipped += codePoint;
    clippedBytes += codePointBytes;
  }
  return { text: clipped, omittedBytes: totalBytes - clippedBytes };
}

function clipList<T>(items: readonly T[]): { items: T[]; omitted: number } {
  return {
    items: items.slice(0, MAX_REPORTED_ITEMS),
    omitted: Math.max(0, items.length - MAX_REPORTED_ITEMS),
  };
}

/** The bounded PR facts shown by pr_context. */
export function describePullRequest(overview: Overview) {
  const body = clipToBytes(overview.body, MAX_BODY_BYTES);
  const checks = clipList(overview.statusCheckRollup ?? []);
  const closingIssues = clipList(overview.closingIssuesReferences);
  return {
    number: overview.number,
    url: overview.url,
    state: overview.state,
    title: clipToBytes(overview.title, 1_000).text,
    baseRefName: overview.baseRefName,
    headRefName: overview.headRefName,
    body: body.text,
    bodyOmittedBytes: body.omittedBytes,
    reportedChecks: {
      total: overview.statusCheckRollup?.length ?? 0,
      omitted: checks.omitted,
      items: checks.items.map((check) =>
        Object.fromEntries(
          REPORTED_CHECK_FIELDS.flatMap((field) =>
            typeof check[field] === "string" ? [[field, check[field]]] : [],
          ),
        ),
      ),
    },
    closingIssues: { omitted: closingIssues.omitted, items: closingIssues.items },
  };
}
