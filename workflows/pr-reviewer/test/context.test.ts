import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

import { findPathVariableName, readPathValue } from "../../../launcher/src/environment.ts";
import {
  createFixtureProject,
  createTemporaryDirectory,
  FIXTURE_DEFAULT_BRANCH,
  removeTemporaryDirectories,
  runGit,
  runHelperScriptFile,
  writeFakeCommand,
} from "../../../launcher/test/fixtures.ts";

const TEAM_DIRECTORY = resolve(import.meta.dir, "..");
const HELPER_PATH = join(TEAM_DIRECTORY, "helpers", "context.ts");
const PR_NUMBER = 37;

afterAll(removeTemporaryDirectories);

function commitFile(projectRoot: string, path: string, content: string): string {
  writeFileSync(join(projectRoot, path), content);
  runGit(projectRoot, ["add", "--", path]);
  runGit(projectRoot, ["commit", "--quiet", "-m", `update ${path}`]);
  return runGit(projectRoot, ["rev-parse", "HEAD"]);
}

function createReviewProject() {
  const { projectRoot } = createFixtureProject("review-app");
  runGit(projectRoot, ["checkout", "--quiet", "-b", "release"]);
  const mergeBaseOid = commitFile(projectRoot, "behavior.txt", "before\n");
  runGit(projectRoot, ["checkout", "--quiet", "-b", "review-head"]);
  const headOid = commitFile(projectRoot, "behavior.txt", "after\n");
  runGit(projectRoot, ["checkout", "--quiet", "release"]);
  const baseOid = commitFile(projectRoot, "base-only.txt", "not part of the PR\n");
  runGit(projectRoot, ["checkout", "--quiet", FIXTURE_DEFAULT_BRANCH]);
  commitFile(projectRoot, "default-only.txt", "not the PR base\n");
  runGit(projectRoot, ["checkout", "--quiet", "review-head"]);
  const pullRequest = {
    number: PR_NUMBER,
    title: "Update release behavior",
    body: "Fixes #12. CI says it passed; this is an unverified claim.",
    url: "https://github.com/example/review-app/pull/37",
    state: "OPEN",
    baseRefName: "release",
    baseRefOid: baseOid,
    headRefName: "review-head",
    headRefOid: headOid,
    files: [{ path: "behavior.txt", additions: 1, deletions: 1 }],
    statusCheckRollup: [{ __typename: "CheckRun", name: "test", conclusion: "SUCCESS" }],
    closingIssuesReferences: [{ number: 12 }],
  };
  const commandDirectory = createTemporaryDirectory();
  const responsePath = join(commandDirectory, "response.json");
  writeFakeCommand(commandDirectory, "gh", join(import.meta.dir, "fixtures", "github.ts"));
  const environment = {
    [findPathVariableName(process.env)]:
      `${commandDirectory}${delimiter}${readPathValue(process.env)}`,
    PR_REVIEWER_RESPONSE: responsePath,
    pr: String(PR_NUMBER),
  };
  function run(arguments_: string[] = []) {
    writeFileSync(responsePath, JSON.stringify(pullRequest));
    return runHelperScriptFile(HELPER_PATH, arguments_, projectRoot, environment);
  }
  return { projectRoot, pullRequest, mergeBaseOid, environment, responsePath, run };
}

describe("pr-reviewer-context", () => {
  test("uses the PR-specific merge base, excluding both later base commits and the default branch", () => {
    const project = createReviewProject();
    const result = project.run();
    expect(result.exitCode).toBe(0);
    expect(result.standardError).toBe("");
    const metadata = result.standardOutput
      .split("BEGIN PR METADATA JSON\n")[1]
      ?.split("\nEND PR METADATA JSON")[0];
    const context: unknown = JSON.parse(metadata ?? "null");
    expect(context).toHaveProperty("snapshot", {
      headOid: project.pullRequest.headRefOid,
      baseOid: project.pullRequest.baseRefOid,
      mergeBaseOid: project.mergeBaseOid,
    });
    expect(context).toHaveProperty("changedPaths", ["behavior.txt"]);
    const diff = result.standardOutput.split("BEGIN PR DIFF\n")[1];
    expect(diff).toStartWith("diff --git a/behavior.txt b/behavior.txt\n");
    expect(diff).toContain(
      "--- a/behavior.txt\n+++ b/behavior.txt\n@@ -1 +1 @@\n-before\n+after\nEND PR DIFF\n",
    );
    expect(result.standardOutput).not.toContain("base-only.txt");
    expect(result.standardOutput).not.toContain("default-only.txt");
    expect(runGit(project.projectRoot, ["status", "--porcelain"])).toBe("");
    expect(runGit(project.projectRoot, ["rev-parse", "HEAD"])).toBe(project.pullRequest.headRefOid);
  });

  test("blocks a stale reused worktree instead of reviewing a different HEAD or repairing it", () => {
    const project = createReviewProject();
    runGit(project.projectRoot, ["checkout", "--quiet", "release"]);
    const result = project.run();
    expect(result.exitCode).toBe(1);
    expect(result.standardOutput).toBe("");
    expect(result.standardError).toContain("does not match PR head");
    expect(result.standardError).toContain("Refresh the PR worktree");
    expect(runGit(project.projectRoot, ["rev-parse", "HEAD"])).toBe(project.pullRequest.baseRefOid);
  });

  test.each(["unstaged", "staged", "untracked"])(
    "blocks %s checkout changes without modifying them",
    (kind) => {
      const project = createReviewProject();
      const path = kind === "untracked" ? "notes.txt" : "behavior.txt";
      writeFileSync(join(project.projectRoot, path), "local work must survive\n");
      if (kind === "staged") {
        runGit(project.projectRoot, ["add", path]);
      }
      const statusBefore = runGit(project.projectRoot, ["status", "--porcelain"]);
      const result = project.run();
      expect(result.exitCode).toBe(1);
      expect(result.standardOutput).toBe("");
      expect(result.standardError).toContain("checkout has tracked or untracked changes");
      expect(runGit(project.projectRoot, ["status", "--porcelain"])).toBe(statusBefore);
      expect(readFileSync(join(project.projectRoot, path), "utf8")).toBe(
        "local work must survive\n",
      );
    },
  );

  test("blocks missing PR base history rather than falling back to the available default branch", () => {
    const project = createReviewProject();
    project.pullRequest.baseRefOid = "f".repeat(40);
    const result = project.run();
    expect(result.exitCode).toBe(1);
    expect(result.standardOutput).toBe("");
    expect(result.standardError).toContain("merge-base for PR base");
    expect(result.standardError).toContain("Fetch the PR base/head history outside this reviewer");
    expect(runGit(project.projectRoot, ["rev-parse", "HEAD"])).toBe(project.pullRequest.headRefOid);
  });

  test("does not execute configured external diff, textconv, or fsmonitor repository commands", () => {
    const project = createReviewProject();
    const driverDirectory = createTemporaryDirectory();
    const driverPath = join(driverDirectory, "unsafe-driver.ts");
    const markerPath = join(driverDirectory, "executed.txt");
    writeFileSync(
      driverPath,
      `await Bun.write(${JSON.stringify(markerPath)}, "executed");\nconsole.log("transformed");\n`,
    );
    const command = `"${process.execPath.replaceAll("\\", "/")}" "${driverPath.replaceAll("\\", "/")}"`;
    runGit(project.projectRoot, ["config", "diff.external", command]);
    runGit(project.projectRoot, ["config", "diff.unsafe.textconv", command]);
    runGit(project.projectRoot, ["config", "core.fsmonitor", command]);
    const attributesPath = runGit(project.projectRoot, [
      "rev-parse",
      "--git-path",
      "info/attributes",
    ]);
    writeFileSync(resolve(project.projectRoot, attributesPath), "behavior.txt diff=unsafe\n");
    const result = project.run();
    expect(result.exitCode).toBe(0);
    expect(result.standardOutput).toContain("-before\n+after\n");
    expect(existsSync(markerPath)).toBe(false);
  });

  test.each(["0", "-1", "1.5", "9007199254740992", "37;echo unsafe"])(
    "rejects invalid PR argument %p before producing context",
    (argument) => {
      const project = createReviewProject();
      const result = project.run([argument]);
      expect(result.exitCode).toBe(2);
      expect(result.standardOutput).toBe("");
      expect(result.standardError).toContain("pr must be a positive safe integer");
    },
  );
});
