import { afterAll, describe, expect, test } from "bun:test";

import { removeTemporaryDirectories } from "#launcher-test/fixtures.ts";

import { createIssueRecord, createTriageProject, ISSUE_NUMBER } from "./triage-project.ts";

afterAll(removeTemporaryDirectories);

const COMMENT = "The reset flow clears the session cookie (src/auth.ts:40). Which version is this?";
const GITHUB_TOKEN_SAMPLE = ["gh", "p", "_", "A".repeat(36)].join("");

function twoChildren(): string {
  return JSON.stringify([
    { title: "Add the parser", body: "Parse the input.\n\nDone when the tests pass." },
    { title: "Render the result", body: "Depends on: Add the parser." },
  ]);
}

describe("triage-apply: the verdicts", () => {
  test("needs-info creates its label, labels the issue and posts one comment with a footer", () => {
    const project = createTriageProject();

    const result = project.runApply({ verdict: "needs-info", comment: COMMENT });

    expect(result.exitCode).toBe(0);
    expect(result.standardOutput).toContain(`Triaged issue #${ISSUE_NUMBER} as j5/needs-info.`);
    const state = project.state();
    const issue = state.issues[String(ISSUE_NUMBER)];
    expect(issue?.labels).toEqual(["bug", "j5/needs-info"]);
    expect(issue?.comments).toHaveLength(1);
    expect(issue?.comments[0]?.body).toContain(COMMENT);
    expect(issue?.comments[0]?.body).toContain("<!-- j5-triage verdict=needs-info -->");
    expect(issue?.comments[0]?.body).toContain("Triaged by the j5 triage agent");
    const createdLabel = state.labels.find((label) => label.name === "j5/needs-info");
    expect(createdLabel?.color).toBe("fbca04");
    expect(createdLabel?.description).toStartWith("Triage:");
    expect(Object.keys(state.issues)).toEqual([String(ISSUE_NUMBER)]);
  });

  // Catches an issue ending up with two verdicts after a second triage, or a repository's own
  // labels being removed.
  test("a new verdict replaces the old verdict label and leaves every other label alone", () => {
    const project = createTriageProject();
    project.update((state) => {
      state.labels = [
        ...state.labels,
        { name: "j5/needs-info", color: "fbca04", description: "Triage" },
      ];
      const issue = state.issues[String(ISSUE_NUMBER)];
      if (issue !== undefined) {
        issue.labels = ["bug", "area/login", "j5/needs-info"];
      }
    });

    const result = project.runApply({
      verdict: "ready",
      comment: "Clear now: see src/auth.ts:40.",
    });

    expect(result.exitCode).toBe(0);
    expect(project.state().issues[String(ISSUE_NUMBER)]?.labels).toEqual([
      "bug",
      "area/login",
      "j5/ready",
    ]);
  });

  test("an existing label is not created again", () => {
    const project = createTriageProject();
    project.update((state) => {
      state.labels = [
        ...state.labels,
        { name: "j5/needs-decision", color: "d93f0b", description: "mine" },
      ];
    });

    project.runApply({ verdict: "needs-decision", comment: "Two options: A or B." });

    expect(
      project.state().calls.filter((call) => call[0] === "label" && call[1] === "create"),
    ).toEqual([]);
  });

  test("split creates linked sub-issues that inherit the parent's labels, then labels and comments on the parent", () => {
    const project = createTriageProject();
    project.update((state) => {
      const issue = state.issues[String(ISSUE_NUMBER)];
      if (issue !== undefined) {
        issue.labels = ["bug", "area/login", "j5/needs-info"];
      }
    });

    const result = project.runApply({
      verdict: "split",
      comment: "Too large for one change: two independent parts, in this order.",
      children: twoChildren(),
    });

    expect(result.exitCode).toBe(0);
    const state = project.state();
    const parent = state.issues[String(ISSUE_NUMBER)];
    expect(parent?.subIssueNumbers).toEqual([100, 101]);
    expect(parent?.labels).toEqual(["bug", "area/login", "j5/split"]);
    const firstChild = state.issues["100"];
    expect(firstChild?.title).toBe("Add the parser");
    expect(firstChild?.labels).toEqual(["bug", "area/login", "j5/ready"]);
    expect(firstChild?.parent?.number).toBe(ISSUE_NUMBER);
    expect(firstChild?.body).toContain("Done when the tests pass.");
    expect(firstChild?.body).toContain(`Part of #${ISSUE_NUMBER}.`);
    expect(parent?.comments).toHaveLength(1);
    expect(parent?.comments[0]?.body).toContain("- #100 Add the parser\n- #101 Render the result");
    expect(result.standardOutput).toContain("Sub-issue #100:");
  });

  // Catches a repository's missing j5/ready label failing the children's creation.
  test("a split creates the j5/ready label for the children when the repository lacks it", () => {
    const project = createTriageProject();

    project.runApply({ verdict: "split", comment: "Split.", children: twoChildren() });

    const names = project.state().labels.map((label) => label.name);
    expect(names).toContain("j5/ready");
    expect(names).toContain("j5/split");
  });
});

describe("triage-apply: dry run", () => {
  // Catches a "dry run" that still writes: the whole point is to look before the first real run.
  test("J5_TRIAGE_DRY_RUN=1 validates and describes the work and changes nothing", () => {
    const project = createTriageProject();

    const result = project.runApply(
      { verdict: "split", comment: "Split.", children: twoChildren() },
      { J5_TRIAGE_DRY_RUN: "1" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.standardOutput).toContain("DRY RUN");
    expect(result.standardOutput).toContain("Would label issue #12: add j5/split");
    expect(result.standardOutput).toContain("Would create sub-issue 1: Add the parser");
    expect(project.writeCalls()).toEqual([]);
    expect(project.state().labels.map((label) => label.name)).toEqual(["bug"]);
  });

  // Catches a dry run skipping validation, which would hide a refusal until the real run.
  test("a dry run still refuses what a real run would refuse", () => {
    const project = createTriageProject();

    const result = project.runApply(
      { verdict: "needs-info", comment: `Pasted ${GITHUB_TOKEN_SAMPLE}` },
      { J5_TRIAGE_DRY_RUN: "1" },
    );

    expect(result.exitCode).toBe(1);
    expect(result.standardError).toContain("appears to contain a GitHub token");
  });
});

describe("triage-apply: refusals write nothing", () => {
  test.each([
    ["a pull request", { isPullRequest: true }, "is a pull request"],
    ["a closed issue", { state: "CLOSED" }, "only open issues are triaged"],
  ])("refuses %s", (_name, change, message) => {
    const project = createTriageProject();
    project.update((state) => {
      state.issues[String(ISSUE_NUMBER)] = createIssueRecord(change);
    });

    const result = project.runApply({ verdict: "needs-info", comment: COMMENT });

    expect(result.exitCode).toBe(1);
    expect(result.standardError).toContain(message);
    expect(project.writeCalls()).toEqual([]);
  });

  test("refuses an archived repository", () => {
    const project = createTriageProject();
    project.update((state) => {
      state.repository.isArchived = true;
    });

    const result = project.runApply({ verdict: "needs-info", comment: COMMENT });

    expect(result.exitCode).toBe(1);
    expect(result.standardError).toContain("is archived");
    expect(project.writeCalls()).toEqual([]);
  });

  // Catches a second split making a second set of children for the same issue.
  test("refuses to split an issue that already has sub-issues", () => {
    const project = createTriageProject();
    project.update((state) => {
      const issue = state.issues[String(ISSUE_NUMBER)];
      if (issue !== undefined) {
        issue.subIssueNumbers = [50];
      }
    });

    const result = project.runApply({
      verdict: "split",
      comment: "Split.",
      children: twoChildren(),
    });

    expect(result.exitCode).toBe(1);
    expect(result.standardError).toContain("already has 1 sub-issue(s)");
    expect(project.writeCalls()).toEqual([]);
  });

  // Catches a credential from the issue being copied into a comment others can read.
  test("refuses a comment that contains a credential", () => {
    const project = createTriageProject();

    const result = project.runApply({
      verdict: "needs-info",
      comment: `The reporter pasted ${GITHUB_TOKEN_SAMPLE}.`,
    });

    expect(result.exitCode).toBe(1);
    expect(result.standardError).toContain("appears to contain a GitHub token");
    expect(project.writeCalls()).toEqual([]);
  });

  test.each([
    ["an unknown verdict", { verdict: "close", comment: COMMENT }, "verdict must be one of"],
    [
      "no comment",
      { verdict: "needs-info", comment: "" },
      "comment must be the triage comment text",
    ],
    ["a split with no children", { verdict: "split", comment: COMMENT }, "needs children"],
    [
      "children on a verdict that is not split",
      { verdict: "ready", comment: COMMENT, children: twoChildren() },
      "only for the split verdict",
    ],
  ])("usage error: %s", (_name, toolArguments, message) => {
    const project = createTriageProject();

    const result = project.runApply(toolArguments);

    expect(result.exitCode).toBe(2);
    expect(result.standardError).toContain(message);
    expect(project.writeCalls()).toEqual([]);
  });
});

describe("triage-apply: running it again", () => {
  // Catches re-running a queue posting the same triage comment twice.
  test("the same verdict again, with nobody commenting in between, is skipped", () => {
    const project = createTriageProject();
    project.runApply({ verdict: "needs-info", comment: COMMENT });

    const second = project.runApply({ verdict: "needs-info", comment: COMMENT });

    expect(second.exitCode).toBe(0);
    expect(second.standardOutput).toContain("Skipped issue #12");
    const issue = project.state().issues[String(ISSUE_NUMBER)];
    expect(issue?.comments).toHaveLength(1);
    expect(project.writeCalls().filter((call) => call === "issue comment")).toHaveLength(1);
  });

  // Catches triage going silent after the reporter answered the questions.
  test("after someone replies, the same verdict is posted again", () => {
    const project = createTriageProject();
    project.runApply({ verdict: "needs-info", comment: COMMENT });
    project.update((state) => {
      const issue = state.issues[String(ISSUE_NUMBER)];
      issue?.comments.push({
        author: { login: "reporter" },
        authorAssociation: "MEMBER",
        body: "Version 2.3, and it also fails on 2.4.",
        createdAt: "2026-10-16T13:00:00Z",
      });
    });

    const second = project.runApply({
      verdict: "needs-info",
      comment: "Thanks, still need the logs.",
    });

    expect(second.standardOutput).toContain("Triaged issue #12 as j5/needs-info.");
    expect(project.state().issues[String(ISSUE_NUMBER)]?.comments).toHaveLength(3);
  });
});

describe("triage-apply: a failure partway through a split", () => {
  // Catches a half-finished split being retried blindly, or looking finished: the parent must not
  // be labeled or commented on, and the error must name what already exists.
  test("leaves the parent unlabeled, posts no comment, and names the child that was created", () => {
    const project = createTriageProject();
    project.update((state) => {
      state.failIssueCreateNumber = 2;
    });

    const result = project.runApply({
      verdict: "split",
      comment: "Split.",
      children: JSON.stringify([
        { title: "One", body: "a" },
        { title: "Two", body: "b" },
        { title: "Three", body: "c" },
      ]),
    });

    expect(result.exitCode).toBe(1);
    expect(result.standardError).toContain("Already created: #100");
    expect(result.standardError).toContain("Do not call triage_apply again for this issue");
    const parent = project.state().issues[String(ISSUE_NUMBER)];
    expect(parent?.labels).toEqual(["bug"]);
    expect(parent?.comments).toEqual([]);
    expect(Object.keys(project.state().issues).toSorted()).toEqual(["100", "12"]);
  });
});
