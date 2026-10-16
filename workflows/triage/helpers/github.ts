// The GitHub calls the triage helpers make, all through the `gh` CLI in the current directory so
// the repository is the one this checkout belongs to and never one the agent names. Responses are
// parsed with schemas, so a change in gh's output fails loudly here instead of reaching the agent
// as a half-read issue.

import { z } from "zod";

import { runAndCapture } from "#launcher/team-helper.ts";

const issueViewSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  state: z.string(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  author: z.object({ login: z.string() }).nullable(),
  labels: z.array(z.object({ name: z.string() })),
  comments: z.array(
    z.object({
      author: z.object({ login: z.string() }).nullable(),
      authorAssociation: z.string(),
      body: z.string(),
      createdAt: z.string(),
    }),
  ),
  // Null for an issue with no parent; the shape of a real parent is read loosely on purpose.
  parent: z.looseObject({ number: z.number().optional(), title: z.string().optional() }).nullable(),
  subIssues: z.object({
    totalCount: z.number(),
    nodes: z.array(z.object({ number: z.number(), title: z.string(), state: z.string() })),
  }),
});

const issueRestSchema = z.looseObject({
  id: z.number(),
  author_association: z.string(),
  pull_request: z.unknown().optional(),
});

const repositorySchema = z.object({
  nameWithOwner: z.string(),
  defaultBranchRef: z.object({ name: z.string() }).nullable(),
  isArchived: z.boolean(),
});

export type Issue = z.infer<typeof issueViewSchema> & {
  /** GitHub's numeric id, which the sub-issue API needs; the issue number is not it. */
  restId: number;
  authorAssociation: string;
};

export type Repository = { nameWithOwner: string; defaultBranch: string; isArchived: boolean };

function parseJson<T>(schema: z.ZodType<T>, text: string, what: string): T {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    throw new Error(`gh printed something other than JSON for ${what}`);
  }
  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`gh's answer for ${what} is not the shape this helper expects`);
  }
  return parsed.data;
}

/** Runs gh with a body on stdin; the repository's labels, comments and issues all take one. */
function runGhWithInput(ghArguments: string[], input: string): string {
  const completedProcess = Bun.spawnSync([Bun.which("gh") ?? "gh", ...ghArguments], {
    stdin: Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (completedProcess.exitCode !== 0) {
    throw new Error(
      `gh ${ghArguments.slice(0, 2).join(" ")} failed (exit ${completedProcess.exitCode}): ${completedProcess.stderr.toString().trim()}`,
    );
  }
  return completedProcess.stdout.toString().trim();
}

export function readRepository(): Repository {
  const repository = parseJson(
    repositorySchema,
    runAndCapture(["gh", "repo", "view", "--json", "nameWithOwner,defaultBranchRef,isArchived"]),
    "the repository",
  );
  return {
    nameWithOwner: repository.nameWithOwner,
    defaultBranch: repository.defaultBranchRef?.name ?? "(unknown)",
    isArchived: repository.isArchived,
  };
}

/**
 * Reads the issue. `gh issue view` also answers for a pull request's number, so the REST record
 * is read as well: it says whether this is a pull request, and has the id and the author's
 * association that the view does not.
 */
export function readIssue(repository: Repository, issueNumber: number): Issue {
  const view = parseJson(
    issueViewSchema,
    runAndCapture([
      "gh",
      "issue",
      "view",
      String(issueNumber),
      "--json",
      "number,title,body,state,url,createdAt,updatedAt,author,labels,comments,parent,subIssues",
    ]),
    `issue #${issueNumber}`,
  );
  const rest = parseJson(
    issueRestSchema,
    runAndCapture(["gh", "api", `repos/${repository.nameWithOwner}/issues/${issueNumber}`]),
    `issue #${issueNumber} (REST)`,
  );
  if (rest.pull_request !== undefined) {
    throw new Error(
      `#${issueNumber} is a pull request, not an issue. Triage is for issues; nothing was written.`,
    );
  }
  return { ...view, restId: rest.id, authorAssociation: rest.author_association };
}

export function listLabelNames(): string[] {
  return parseJson(
    z.array(z.object({ name: z.string() })),
    runAndCapture(["gh", "label", "list", "--json", "name", "--limit", "1000"]),
    "the repository's labels",
  ).map((label) => label.name);
}

export function createLabel(label: { name: string; color: string; description: string }): void {
  runAndCapture([
    "gh",
    "label",
    "create",
    label.name,
    "--color",
    label.color,
    "--description",
    label.description,
  ]);
}

export function editLabels(issueNumber: number, add: string[], remove: string[]): void {
  if (add.length === 0 && remove.length === 0) {
    return;
  }
  runAndCapture([
    "gh",
    "issue",
    "edit",
    String(issueNumber),
    ...add.flatMap((name) => ["--add-label", name]),
    ...remove.flatMap((name) => ["--remove-label", name]),
  ]);
}

/** Posts a comment and returns its URL. */
export function postComment(issueNumber: number, body: string): string {
  return runGhWithInput(["issue", "comment", String(issueNumber), "--body-file", "-"], body);
}

/** Creates an issue and returns its number and URL. */
export function createIssue(
  title: string,
  body: string,
  labelNames: string[],
): { number: number; url: string } {
  const url = runGhWithInput(
    [
      "issue",
      "create",
      "--title",
      title,
      "--body-file",
      "-",
      ...labelNames.flatMap((name) => ["--label", name]),
    ],
    body,
  );
  const createdNumber = /\/issues\/(\d+)\s*$/.exec(url)?.[1];
  if (createdNumber === undefined) {
    throw new Error(`gh issue create did not print an issue URL: ${url}`);
  }
  return { number: Number(createdNumber), url };
}

/** The numeric id the sub-issue API wants for a child issue. */
export function readIssueRestId(repository: Repository, issueNumber: number): number {
  return parseJson(
    issueRestSchema,
    runAndCapture(["gh", "api", `repos/${repository.nameWithOwner}/issues/${issueNumber}`]),
    `issue #${issueNumber} (REST)`,
  ).id;
}

export function linkSubIssue(
  repository: Repository,
  parentNumber: number,
  childRestId: number,
): void {
  runAndCapture([
    "gh",
    "api",
    "--method",
    "POST",
    `repos/${repository.nameWithOwner}/issues/${parentNumber}/sub_issues`,
    "-F",
    `sub_issue_id=${childRestId}`,
  ]);
}
