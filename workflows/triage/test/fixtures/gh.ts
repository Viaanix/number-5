// A fake `gh` for the triage helpers. Only the remote GitHub calls are simulated; the state lives
// in the JSON file named by TRIAGE_GH_STATE, so a test can seed an issue, run a helper, and read
// back what was written. Every invocation is recorded in `calls` before it is handled, so a test
// can also prove that nothing was written (a refusal, a dry run).
import { readFileSync, writeFileSync } from "node:fs";

import { z } from "zod";

export type FakeComment = {
  author: { login: string } | null;
  authorAssociation: string;
  body: string;
  createdAt: string;
};

export type FakeIssue = {
  number: number;
  restId: number;
  title: string;
  body: string;
  state: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  authorAssociation: string;
  labels: string[];
  comments: FakeComment[];
  parent: { number: number; title: string } | null;
  subIssueNumbers: number[];
  isPullRequest: boolean;
};

export type FakeState = {
  repository: { nameWithOwner: string; defaultBranch: string; isArchived: boolean };
  issues: Record<string, FakeIssue>;
  labels: Array<{ name: string; color: string; description: string }>;
  nextIssueNumber: number;
  nextRestId: number;
  /** Every invocation's arguments, in order. */
  calls: string[][];
  /** The `issue create` call (1-based) that fails, to simulate a failure partway through. */
  failIssueCreateNumber: number | undefined;
};

const configuredStatePath = process.env.TRIAGE_GH_STATE;
if (configuredStatePath === undefined) {
  console.error("fake gh: TRIAGE_GH_STATE is not set");
  process.exit(1);
}
// Narrowing does not carry into functions, so the checked value is kept in a typed constant.
const statePath: string = configuredStatePath;
const state = z.custom<FakeState>().parse(JSON.parse(readFileSync(statePath, "utf8")));
const ghArguments = Bun.argv.slice(2);
state.calls = [...state.calls, ghArguments];

function save(): void {
  writeFileSync(statePath, JSON.stringify(state));
}

function fail(message: string): never {
  save();
  console.error(message);
  process.exit(1);
}

function flagValues(flag: string): string[] {
  return ghArguments.flatMap((argument, index) =>
    argument === flag ? [ghArguments[index + 1] ?? ""] : [],
  );
}

function requireIssue(rawNumber: string | undefined): FakeIssue {
  const issue = state.issues[rawNumber ?? ""];
  if (issue === undefined) {
    return fail(`GraphQL: Could not resolve to an issue with the number ${rawNumber}`);
  }
  return issue;
}

const [command, subcommand] = ghArguments;
const repositoryPath = state.repository.nameWithOwner;

if (command === "repo" && subcommand === "view") {
  console.log(
    JSON.stringify({
      nameWithOwner: repositoryPath,
      defaultBranchRef: { name: state.repository.defaultBranch },
      isArchived: state.repository.isArchived,
    }),
  );
} else if (command === "issue" && subcommand === "view") {
  const issue = requireIssue(ghArguments[2]);
  console.log(
    JSON.stringify({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      url: issue.url,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      author: issue.author,
      labels: issue.labels.map((name) => ({ name })),
      comments: issue.comments,
      parent: issue.parent,
      subIssues: {
        totalCount: issue.subIssueNumbers.length,
        nodes: issue.subIssueNumbers.map((number) => ({
          number,
          title: state.issues[String(number)]?.title ?? "",
          state: "OPEN",
        })),
      },
    }),
  );
} else if (command === "api" && ghArguments[1]?.startsWith("repos/") === true) {
  const issue = requireIssue(/\/issues\/(\d+)$/.exec(ghArguments[1])?.[1]);
  console.log(
    JSON.stringify({
      id: issue.restId,
      author_association: issue.authorAssociation,
      ...(issue.isPullRequest ? { pull_request: { url: "https://example.invalid/pull" } } : {}),
    }),
  );
} else if (command === "api" && ghArguments.includes("--method")) {
  const parentNumber = /\/issues\/(\d+)\/sub_issues$/.exec(ghArguments.at(-3) ?? "")?.[1];
  const childRestId = Number(/^sub_issue_id=(\d+)$/.exec(ghArguments.at(-1) ?? "")?.[1]);
  const parent = requireIssue(parentNumber);
  const child = Object.values(state.issues).find((candidate) => candidate.restId === childRestId);
  if (child === undefined) {
    fail(`fake gh: no issue has the id ${childRestId}`);
  } else {
    parent.subIssueNumbers = [...parent.subIssueNumbers, child.number];
    child.parent = { number: parent.number, title: parent.title };
    console.log("{}");
  }
} else if (command === "label" && subcommand === "list") {
  console.log(JSON.stringify(state.labels.map((label) => ({ name: label.name }))));
} else if (command === "label" && subcommand === "create") {
  state.labels = [
    ...state.labels,
    {
      name: ghArguments[2] ?? "",
      color: flagValues("--color")[0] ?? "",
      description: flagValues("--description")[0] ?? "",
    },
  ];
} else if (command === "issue" && subcommand === "edit") {
  const issue = requireIssue(ghArguments[2]);
  const toRemove = flagValues("--remove-label");
  issue.labels = [
    ...issue.labels.filter((name) => !toRemove.includes(name)),
    ...flagValues("--add-label"),
  ];
} else if (command === "issue" && subcommand === "comment") {
  const issue = requireIssue(ghArguments[2]);
  const body = await Bun.stdin.text();
  issue.comments = [
    ...issue.comments,
    {
      author: { login: "triage-bot" },
      authorAssociation: "MEMBER",
      body,
      createdAt: "2026-10-16T12:00:00Z",
    },
  ];
  console.log(`${issue.url}#issuecomment-${issue.comments.length}`);
} else if (command === "issue" && subcommand === "create") {
  const createCallNumber = state.calls.filter(
    (call) => call[0] === "issue" && call[1] === "create",
  ).length;
  if (state.failIssueCreateNumber === createCallNumber) {
    fail("GraphQL: Resource not accessible by integration (simulated failure)");
  }
  const number = state.nextIssueNumber;
  state.nextIssueNumber += 1;
  const restId = state.nextRestId;
  state.nextRestId += 1;
  const url = `https://github.com/${repositoryPath}/issues/${number}`;
  state.issues[String(number)] = {
    number,
    restId,
    title: flagValues("--title")[0] ?? "",
    body: await Bun.stdin.text(),
    state: "OPEN",
    url,
    createdAt: "2026-10-16T12:00:00Z",
    updatedAt: "2026-10-16T12:00:00Z",
    author: { login: "triage-bot" },
    authorAssociation: "MEMBER",
    labels: flagValues("--label"),
    comments: [],
    parent: null,
    subIssueNumbers: [],
    isPullRequest: false,
  };
  console.log(url);
} else {
  fail(`fake gh: unsupported call: gh ${ghArguments.join(" ")}`);
}
save();
