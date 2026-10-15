// A real git repository shaped like a pull request (merge base, a later base commit, a
// default branch that is not the PR base), with only the GitHub calls faked.
import { readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

import {
  createFixtureProject,
  createTemporaryDirectory,
  FIXTURE_DEFAULT_BRANCH,
  runGit,
  runHelperScriptFile,
  writeFakeCommand,
  type HelperResult,
} from "#launcher-test/fixtures.ts";
import { findPathVariableName, readPathValue } from "#launcher/environment.ts";

const TEAM_DIRECTORY = resolve(import.meta.dir, "..");
const CONTEXT_HELPER_PATH = join(TEAM_DIRECTORY, "helpers", "context.ts");
const DIFF_HELPER_PATH = join(TEAM_DIRECTORY, "helpers", "diff.ts");
const COMMENT_HELPER_PATH = join(TEAM_DIRECTORY, "helpers", "comment.ts");
export const PR_NUMBER = 37;

export interface ReviewPullRequest {
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

export interface ReviewProject {
  projectRoot: string;
  pullRequest: ReviewPullRequest;
  mergeBaseOid: string;
  /** Runs pr_context; extra arguments override the pr environment value. */
  run(arguments_?: string[]): HelperResult;
  /** Runs pr_diff for one page. */
  runDiffPage(page: string, arguments_?: string[]): HelperResult;
  /** Runs pr_comment with this report text; extra variables override the fake gh's setup. */
  runComment(report: string, extraEnvironment?: Record<string, string>): HelperResult;
  /** The text the fake gh received for the comment, or undefined when none was posted. */
  postedComment(): string | undefined;
}

export function commitFile(projectRoot: string, path: string, content: string): string {
  writeFileSync(join(projectRoot, path), content);
  runGit(projectRoot, ["add", "--", path]);
  runGit(projectRoot, ["commit", "--quiet", "-m", `update ${path}`]);
  return runGit(projectRoot, ["rev-parse", "HEAD"]);
}

export function createReviewProject(): ReviewProject {
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
  const commentPath = join(commandDirectory, "comment.txt");
  writeFakeCommand(commandDirectory, "gh", join(import.meta.dir, "fixtures", "github.ts"));
  const environment = {
    [findPathVariableName(process.env)]:
      `${commandDirectory}${delimiter}${readPathValue(process.env)}`,
    PR_REVIEWER_RESPONSE: responsePath,
    PR_REVIEWER_COMMENT: commentPath,
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
  function runComment(report: string, extraEnvironment: Record<string, string> = {}): HelperResult {
    writeFileSync(responsePath, JSON.stringify(pullRequest));
    return runHelperScriptFile(COMMENT_HELPER_PATH, [], projectRoot, {
      ...environment,
      ...extraEnvironment,
      body: report,
    });
  }
  function postedComment(): string | undefined {
    try {
      return readFileSync(commentPath, "utf8");
    } catch {
      return undefined;
    }
  }
  return { projectRoot, pullRequest, mergeBaseOid, run, runDiffPage, runComment, postedComment };
}
