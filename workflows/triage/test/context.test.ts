import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { removeTemporaryDirectories, runGit } from "#launcher-test/fixtures.ts";

import { createTriageProject, ISSUE_NUMBER } from "./triage-project.ts";

afterAll(removeTemporaryDirectories);

describe("triage-context", () => {
  test("prints the issue and the commit and branch of the checkout it will be read from", () => {
    const project = createTriageProject();
    const head = runGit(project.projectRoot, ["rev-parse", "HEAD"]).trim();

    const result = project.runContext();

    expect(result.exitCode).toBe(0);
    expect(result.standardError).toBe("");
    expect(result.standardOutput).toContain(`example/triage-app issue #${ISSUE_NUMBER}`);
    expect(result.standardOutput).toContain(`commit ${head} on branch trunk`);
    expect(result.standardOutput).toContain("Title: Login fails after the password reset");
  });

  // Catches triaging a pull request as if it were an issue: `gh issue view` answers for a
  // pull request's number too, and the verdict labels would land on the PR.
  test("refuses a pull request's number and prints no issue text", () => {
    const project = createTriageProject();
    project.update((state) => {
      const issue = state.issues[String(ISSUE_NUMBER)];
      if (issue !== undefined) {
        issue.isPullRequest = true;
      }
    });

    const result = project.runContext();

    expect(result.exitCode).toBe(1);
    expect(result.standardError).toContain("is a pull request, not an issue");
    expect(result.standardOutput).toBe("");
  });

  // Catches the triager reading the code of a half-edited checkout without being told.
  test("says when the working tree has uncommitted changes", () => {
    const project = createTriageProject();
    writeFileSync(join(project.projectRoot, "scratch.txt"), "edited\n");

    const result = project.runContext();

    expect(result.standardOutput).toContain("the working tree has uncommitted changes");
  });

  test("shows a closed issue's state instead of hiding it", () => {
    const project = createTriageProject();
    project.update((state) => {
      const issue = state.issues[String(ISSUE_NUMBER)];
      if (issue !== undefined) {
        issue.state = "CLOSED";
      }
    });

    expect(project.runContext().standardOutput).toContain("State: CLOSED");
  });

  test("a missing issue number is a usage error and writes nothing", () => {
    const project = createTriageProject();

    const result = project.runContext({ issue: "" });

    expect(result.exitCode).toBe(2);
    expect(result.standardError).toContain("positive issue number");
    expect(project.writeCalls()).toEqual([]);
  });

  test("never writes to GitHub", () => {
    const project = createTriageProject();

    project.runContext();

    expect(project.writeCalls()).toEqual([]);
  });
});
