import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

import { z } from "zod";

import { findPathVariableName, readPathValue } from "../../../launcher/src/environment.ts";
import {
  createFixtureProject,
  createTemporaryDirectory,
  FIXTURE_DEFAULT_BRANCH,
  removeTemporaryDirectories,
  runGit,
  runHelperScriptFile,
  writeFakeCommand,
  type HelperResult,
} from "../../../launcher/test/fixtures.ts";
import { MAX_BODY_BYTES, paginate } from "../helpers/snapshot.ts";

const TEAM_DIRECTORY = resolve(import.meta.dir, "..");
const CONTEXT_HELPER_PATH = join(TEAM_DIRECTORY, "helpers", "context.ts");
const DIFF_HELPER_PATH = join(TEAM_DIRECTORY, "helpers", "diff.ts");
const PR_NUMBER = 37;
/** docker-agent drops the start of any tool result larger than this. */
const DOCKER_AGENT_TOOL_RESULT_LIMIT = 51_200;

afterAll(removeTemporaryDirectories);

interface ReviewPullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  baseRefName: string;
  baseRefOid: string;
  headRefName: string;
  headRefOid: string;
  files: { path: string; additions: number; deletions: number }[];
  statusCheckRollup: Record<string, string>[];
  closingIssuesReferences: { number: number }[];
}

interface ReviewProject {
  projectRoot: string;
  pullRequest: ReviewPullRequest;
  mergeBaseOid: string;
  /** Runs pr_context; extra arguments override the pr environment value. */
  run(arguments_?: string[]): HelperResult;
  /** Runs pr_diff for one page. */
  runDiffPage(page: string, arguments_?: string[]): HelperResult;
}

const metadataSchema = z.object({
  snapshot: z.object({ headOid: z.string(), baseOid: z.string(), mergeBaseOid: z.string() }),
  changedPathCount: z.number(),
  diff: z.object({ sha256: z.string(), bytes: z.number(), pages: z.number() }),
  pullRequest: z.object({
    body: z.string(),
    bodyOmittedBytes: z.number(),
    reportedChecks: z.object({
      total: z.number(),
      omitted: z.number(),
      items: z.array(z.unknown()),
    }),
  }),
});
type ContextMetadata = z.infer<typeof metadataSchema>;

interface DiffPage {
  header: string;
  fingerprintLine: string;
  content: string;
  byteLength: number;
}

function commitFile(projectRoot: string, path: string, content: string): string {
  writeFileSync(join(projectRoot, path), content);
  runGit(projectRoot, ["add", "--", path]);
  runGit(projectRoot, ["commit", "--quiet", "-m", `update ${path}`]);
  return runGit(projectRoot, ["rev-parse", "HEAD"]);
}

function createReviewProject(): ReviewProject {
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
  const pullRequest: ReviewPullRequest = {
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
  function run(arguments_: string[] = []): HelperResult {
    writeFileSync(responsePath, JSON.stringify(pullRequest));
    return runHelperScriptFile(CONTEXT_HELPER_PATH, arguments_, projectRoot, environment);
  }
  function runDiffPage(page: string, arguments_: string[] = []): HelperResult {
    writeFileSync(responsePath, JSON.stringify(pullRequest));
    return runHelperScriptFile(DIFF_HELPER_PATH, arguments_, projectRoot, {
      ...environment,
      page,
    });
  }
  return { projectRoot, pullRequest, mergeBaseOid, run, runDiffPage };
}

function readMetadata(standardOutput: string): ContextMetadata {
  const metadata = standardOutput
    .split("BEGIN PR METADATA JSON\n")[1]
    ?.split("\nEND PR METADATA JSON")[0];
  return metadataSchema.parse(JSON.parse(metadata ?? "null"));
}

function readDiffPages(project: ReviewProject, pageCount: number): DiffPage[] {
  return Array.from({ length: pageCount }, (_unused, index) => {
    const result = project.runDiffPage(String(index + 1));
    expect(result.exitCode).toBe(0);
    expect(result.standardError).toBe("");
    const label = `${index + 1} OF ${pageCount}`;
    const lines = result.standardOutput.split("\n");
    expect(lines[0]).toBe(`BEGIN PR DIFF PAGE ${label}`);
    const footer = `END PR DIFF PAGE ${label}\n`;
    expect(result.standardOutput.endsWith(footer)).toBe(true);
    return {
      header: lines[1] ?? "",
      fingerprintLine: lines[2] ?? "",
      content: lines.slice(3).join("\n").slice(0, -footer.length),
      byteLength: Buffer.byteLength(result.standardOutput),
    };
  });
}

function addLargeChange(project: ReviewProject): void {
  const content = Array.from(
    { length: 4_000 },
    (_unused, index) => `generated line ${index}\n`,
  ).join("");
  project.pullRequest.headRefOid = commitFile(project.projectRoot, "large.txt", content);
}

describe("pr-reviewer-context", () => {
  test("pr_diff pages use the PR-specific merge base, excluding both later base commits and the default branch", () => {
    const project = createReviewProject();
    const result = project.run();
    expect(result.exitCode).toBe(0);
    expect(result.standardError).toBe("");
    const context = readMetadata(result.standardOutput);
    expect(context).toHaveProperty("snapshot", {
      headOid: project.pullRequest.headRefOid,
      baseOid: project.pullRequest.baseRefOid,
      mergeBaseOid: project.mergeBaseOid,
    });
    expect(context).toHaveProperty("changedPathCount", 1);
    expect(context).toHaveProperty("diff.pages", 1);
    const [page] = readDiffPages(project, 1);
    expect(page?.header).toBe(
      `snapshot: head=${project.pullRequest.headRefOid} base=${project.pullRequest.baseRefOid} mergeBase=${project.mergeBaseOid}`,
    );
    expect(page?.content).toStartWith("CHANGED PATHS\nbehavior.txt\nDIFF STAT\n");
    expect(page?.content).toContain("DIFF\ndiff --git a/behavior.txt b/behavior.txt\n");
    expect(page?.content).toContain(
      "--- a/behavior.txt\n+++ b/behavior.txt\n@@ -1 +1 @@\n-before\n+after\n",
    );
    expect(result.standardOutput).not.toContain("base-only.txt");
    expect(page?.content).not.toContain("base-only.txt");
    expect(page?.content).not.toContain("default-only.txt");
    expect(runGit(project.projectRoot, ["status", "--porcelain"])).toBe("");
    expect(runGit(project.projectRoot, ["rev-parse", "HEAD"])).toBe(project.pullRequest.headRefOid);
  });

  test("keeps every result under docker-agent's limit for a diff that does not fit in one result", () => {
    const project = createReviewProject();
    addLargeChange(project);
    const context = project.run();
    expect(context.exitCode).toBe(0);
    expect(Buffer.byteLength(context.standardOutput)).toBeLessThan(DOCKER_AGENT_TOOL_RESULT_LIMIT);
    const { diff } = readMetadata(context.standardOutput);
    expect(diff.pages).toBeGreaterThan(1);
    const pages = readDiffPages(project, diff.pages);
    for (const page of pages) {
      expect(page.byteLength).toBeLessThan(DOCKER_AGENT_TOOL_RESULT_LIMIT);
      expect(page.fingerprintLine).toBe(`diff: sha256=${diff.sha256} bytes=${diff.bytes}`);
    }
    // The pages are the whole evidence: nothing lost, duplicated or reordered.
    const reassembled = pages.map((page) => page.content).join("");
    expect(createHash("sha256").update(reassembled).digest("hex")).toBe(diff.sha256);
    expect(Buffer.byteLength(reassembled)).toBe(diff.bytes);
    expect(reassembled).toContain("+generated line 0\n");
    expect(reassembled).toContain("+generated line 3999\n");
  });

  test("keeps the diff stat free of the patch, so the diff is not delivered twice", () => {
    const project = createReviewProject();
    const [page] = readDiffPages(project, 1);
    const stat = page?.content.split("DIFF STAT\n")[1]?.split("DIFF\n")[0] ?? "";
    expect(stat).toContain("behavior.txt");
    expect(stat).not.toContain("@@");
    expect(page?.content.match(/\+after\n/g)).toHaveLength(1);
  });

  test("bounds untrusted PR text in the overview while reporting what was omitted", () => {
    const project = createReviewProject();
    project.pullRequest.body = "é".repeat(MAX_BODY_BYTES);
    project.pullRequest.statusCheckRollup = Array.from({ length: 80 }, (_unused, index) => ({
      __typename: "CheckRun",
      name: `check-${index}`,
      conclusion: "SUCCESS",
    }));
    const result = project.run();
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.standardOutput)).toBeLessThan(DOCKER_AGENT_TOOL_RESULT_LIMIT);
    const { pullRequest } = readMetadata(result.standardOutput);
    expect(Buffer.byteLength(pullRequest.body)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(pullRequest.bodyOmittedBytes).toBe(MAX_BODY_BYTES);
    expect(pullRequest.body).not.toContain("\uFFFD");
    expect(pullRequest.reportedChecks).toMatchObject({ total: 80, omitted: 30 });
    expect(pullRequest.reportedChecks.items).toHaveLength(50);
  });

  test("changes the diff fingerprint when the diff changes, so the final gate can detect it", () => {
    const project = createReviewProject();
    const first = readMetadata(project.run().standardOutput).diff;
    project.pullRequest.headRefOid = commitFile(
      project.projectRoot,
      "behavior.txt",
      "changed again\n",
    );
    const second = readMetadata(project.run().standardOutput).diff;
    expect(second.sha256).not.toBe(first.sha256);
  });

  test("blocks a stale reused worktree instead of reviewing a different HEAD or repairing it", () => {
    const project = createReviewProject();
    runGit(project.projectRoot, ["checkout", "--quiet", "release"]);
    for (const result of [project.run(), project.runDiffPage("1")]) {
      expect(result.exitCode).toBe(1);
      expect(result.standardOutput).toBe("");
      expect(result.standardError).toContain("does not match PR head");
      expect(result.standardError).toContain("Refresh the PR worktree");
    }
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
      for (const result of [project.run(), project.runDiffPage("1")]) {
        expect(result.exitCode).toBe(1);
        expect(result.standardOutput).toBe("");
        expect(result.standardError).toContain("checkout has tracked or untracked changes");
      }
      expect(runGit(project.projectRoot, ["status", "--porcelain"])).toBe(statusBefore);
      expect(readFileSync(join(project.projectRoot, path), "utf8")).toBe(
        "local work must survive\n",
      );
    },
  );

  test("blocks missing PR base history rather than falling back to the available default branch", () => {
    const project = createReviewProject();
    project.pullRequest.baseRefOid = "f".repeat(40);
    for (const result of [project.run(), project.runDiffPage("1")]) {
      expect(result.exitCode).toBe(1);
      expect(result.standardOutput).toBe("");
      expect(result.standardError).toContain("merge-base for PR base");
      expect(result.standardError).toContain(
        "Fetch the PR base/head history outside this reviewer",
      );
    }
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
    expect(project.run().exitCode).toBe(0);
    const result = project.runDiffPage("1");
    expect(result.exitCode).toBe(0);
    expect(result.standardOutput).toContain("-before\n+after\n");
    expect(existsSync(markerPath)).toBe(false);
  });

  test.each(["0", "-1", "1.5", "9007199254740992", "37;echo unsafe"])(
    "rejects invalid PR argument %p before producing context",
    (argument) => {
      const project = createReviewProject();
      for (const result of [project.run([argument]), project.runDiffPage("1", [argument])]) {
        expect(result.exitCode).toBe(2);
        expect(result.standardOutput).toBe("");
        expect(result.standardError).toContain("pr must be a positive safe integer");
      }
    },
  );

  test.each(["0", "-1", "1.5", "9007199254740992", "two", ""])(
    "rejects invalid page %p instead of returning some other page",
    (page) => {
      const result = createReviewProject().runDiffPage(page);
      expect(result.exitCode).toBe(2);
      expect(result.standardOutput).toBe("");
      expect(result.standardError).toContain("page must be a positive safe integer");
    },
  );

  test("reports a page past the end with the real page count instead of an empty page", () => {
    const result = createReviewProject().runDiffPage("2");
    expect(result.exitCode).toBe(1);
    expect(result.standardOutput).toBe("");
    expect(result.standardError).toContain(
      "page 2 is out of range; this diff has pages 1 through 1.",
    );
  });
});

describe("paginate", () => {
  const limit = 40;

  test("reproduces the text exactly with every page within the byte limit, including multibyte text and over-long lines", () => {
    const text = `${"a".repeat(25)}\n${"é".repeat(60)}\n${"b".repeat(15)}\nshort\n${"x".repeat(100)}`;
    const pages = paginate(text, limit);
    expect(pages.join("")).toBe(text);
    for (const page of pages) {
      expect(Buffer.byteLength(page)).toBeLessThanOrEqual(limit);
      expect(page).not.toContain("\uFFFD");
    }
  });

  test("keeps whole lines together when they fit, so hunks are not cut mid-line needlessly", () => {
    const pages = paginate(`${"a".repeat(30)}\n${"b".repeat(30)}\n`, limit);
    expect(pages).toEqual([`${"a".repeat(30)}\n`, `${"b".repeat(30)}\n`]);
  });

  test("returns one empty page for empty text so a page 1 always exists", () => {
    expect(paginate("", limit)).toEqual([""]);
  });
});
