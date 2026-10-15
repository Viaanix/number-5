import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { removeTemporaryDirectories } from "../../../launcher/test/fixtures.ts";
import { MAX_COMMENT_CHARACTERS } from "../helpers/report.ts";
import { commitFile, createReviewProject, type ReviewProject } from "./review-project.ts";

afterAll(removeTemporaryDirectories);

function finishedReport(project: ReviewProject, verdict = "Needs work"): string {
  return [
    `VERDICT: ${verdict}`,
    `PR: ${project.pullRequest.url} (#${project.pullRequest.number})`,
    `Reviewed head SHA: ${project.pullRequest.headRefOid}`,
    "",
    "### Findings",
    "1. **Example** — blocker — behavior.txt:1",
    "",
  ].join("\n");
}

/** Credential shapes are assembled at run time so this file is not itself a secret-scan hit. */
const CREDENTIAL_SAMPLES: Record<string, string> = {
  "private key block": ["-----BEGIN ", "RSA", " PRIVATE KEY-----"].join(""),
  "Anthropic or OpenAI API key": ["sk-", "ant-", "a1".repeat(15)].join(""),
  "GitHub token": ["gh", "p", "_", "A".repeat(36)].join(""),
  "AWS access key ID": ["AKIA", "B".repeat(16)].join(""),
  "Slack token": ["xox", "b", "-", "1".repeat(12)].join(""),
  "JSON web token": [
    "eyJ".concat("a".repeat(12)),
    "eyJ".concat("b".repeat(12)),
    "c".repeat(12),
  ].join("."),
};

describe("pr-reviewer-comment", () => {
  test("posts the finished report as a plain PR comment with an attribution footer", () => {
    const project = createReviewProject();
    const report = finishedReport(project);
    const result = project.runComment(report);
    expect(result.exitCode).toBe(0);
    expect(result.standardError).toBe("");
    expect(result.standardOutput).toContain(
      "Posted comment on PR 37: https://github.com/example/review-app/pull/37#issuecomment-1",
    );
    const posted = project.postedComment();
    expect(posted).toStartWith(report.trimEnd());
    expect(posted).toContain("Static review by the j5 pr-reviewer agent");
  });

  test.each(["Ship it", "Approve-with-nits", "Needs work"])("accepts the %s verdict", (verdict) => {
    const project = createReviewProject();
    expect(project.runComment(finishedReport(project, verdict)).exitCode).toBe(0);
  });

  test("drops an invented 'Comment posted' line from the posted text, keeping the rest", () => {
    const project = createReviewProject();
    const report = finishedReport(project);
    const result = project.runComment(
      `${report}\nComment posted: https://github.com/example/review-app/pull/37#issuecomment-pending\n`,
    );
    expect(result.exitCode).toBe(0);
    const posted = project.postedComment() ?? "";
    expect(posted).toStartWith(report.trimEnd());
    expect(posted).not.toContain("Comment posted:");
    expect(posted).not.toContain("issuecomment-pending");
  });

  test.each([
    ["a BLOCKED result", "BLOCKED: pr_context failed\nPR: 37\nReview verdict: Not issued.\n"],
    ["text before the verdict line", "Here is my review.\nVERDICT: Ship it\n"],
    ["an unknown verdict", "VERDICT: LGTM\nReviewed head SHA: abc\n"],
  ])("refuses %s and posts nothing", (_name, report) => {
    const project = createReviewProject();
    const result = project.runComment(report);
    expect(result.exitCode).toBe(1);
    expect(result.standardError).toContain("only a finished review report is posted");
    expect(project.postedComment()).toBeUndefined();
  });

  test("refuses a report that does not say which commit it reviewed", () => {
    const project = createReviewProject();
    for (const report of [
      "VERDICT: Ship it\nPR: x\n",
      "VERDICT: Ship it\nReviewed head SHA: not-a-commit\n",
    ]) {
      const result = project.runComment(report);
      expect(result.exitCode).toBe(1);
      expect(result.standardError).toContain("Reviewed head SHA");
    }
    expect(project.postedComment()).toBeUndefined();
  });

  test("refuses a report about an old commit once the PR and checkout have moved on", () => {
    const project = createReviewProject();
    const report = finishedReport(project);
    project.pullRequest.headRefOid = commitFile(project.projectRoot, "behavior.txt", "newer\n");
    const result = project.runComment(report);
    expect(result.exitCode).toBe(1);
    expect(result.standardError).toContain("A comment about an old commit is not posted");
    expect(project.postedComment()).toBeUndefined();
  });

  test("refuses a dirty checkout, whose state the report did not describe", () => {
    const project = createReviewProject();
    writeFileSync(join(project.projectRoot, "notes.txt"), "uncommitted\n");
    const result = project.runComment(finishedReport(project));
    expect(result.exitCode).toBe(1);
    expect(result.standardError).toContain("checkout has tracked or untracked changes");
    expect(project.postedComment()).toBeUndefined();
  });

  test.each(Object.entries(CREDENTIAL_SAMPLES))(
    "refuses a report containing a %s without echoing it",
    (name, sample) => {
      const project = createReviewProject();
      const result = project.runComment(`${finishedReport(project)}\nSeen in config: ${sample}\n`);
      expect(result.exitCode).toBe(1);
      expect(result.standardError).toContain(`appears to contain a ${name}`);
      expect(result.standardError).not.toContain(sample);
      expect(project.postedComment()).toBeUndefined();
    },
  );

  test("does not mistake ordinary review text for a credential", () => {
    const project = createReviewProject();
    const report = `${finishedReport(project)}\nThe key is sk-learn style naming; see ghp docs and AKIA prefixes in prose.\n`;
    expect(project.runComment(report).exitCode).toBe(0);
  });

  test("refuses a report over the length limit and says how to proceed", () => {
    const project = createReviewProject();
    const result = project.runComment(
      `${finishedReport(project)}${"x".repeat(MAX_COMMENT_CHARACTERS)}`,
    );
    expect(result.exitCode).toBe(1);
    expect(result.standardError).toContain("Shorten the report");
    expect(project.postedComment()).toBeUndefined();
  });

  test("rejects a missing report as a usage error", () => {
    const result = createReviewProject().runComment("");
    expect(result.exitCode).toBe(2);
    expect(result.standardError).toContain("body must be the finished review report");
  });

  test("reports a failed gh call instead of claiming the comment was posted", () => {
    const project = createReviewProject();
    const result = project.runComment(finishedReport(project), {
      PR_REVIEWER_COMMENT: join(project.projectRoot, "missing-directory", "comment.txt"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.standardOutput).not.toContain("Posted comment");
    expect(result.standardError).toContain("gh pr comment failed");
    expect(result.standardError).toContain("do not retry");
  });
});
