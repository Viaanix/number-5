import { describe, expect, test } from "bun:test";

import type { WorkflowManifest } from "../src/manifest.ts";
import { buildLaunchPlan, type LaunchRequest } from "../src/plan.ts";

const TEAM_CONFIG_PATH = "/teams/sample/team.yaml";
const TEAM_BIN_DIRECTORY = "/teams/sample/bin";
const PROJECT_ROOT = "/code/my-app";
const INHERITED_PATH = "/usr/local/bin:/usr/bin";

const SAMPLE_MANIFEST: WorkflowManifest = {
  name: "sample-team",
  description: "test team",
  team: "team.yaml",
  path: ["bin"],
  directory: "/teams/sample",
  teamConfigPath: TEAM_CONFIG_PATH,
  pathDirectories: [TEAM_BIN_DIRECTORY],
  entrypoints: {
    "work-issue": {
      description: "d",
      agent: "root",
      parameters: { issue: { type: "integer", label: "Issue" } },
      worktree: { mode: "new", name: "{repo}-issue-{issue}" },
      message: "Work issue #{issue}",
    },
    "pr-followup": {
      description: "d",
      agent: "followup",
      parameters: { pr: { type: "integer", label: "PR" } },
      worktree: { mode: "pr", pull_request_parameter: "pr" },
      message: "Follow up on PR #{pr} in {repo}",
    },
    chat: {
      description: "d",
      agent: "root",
      parameters: { topic: { type: "string", label: "Topic" } },
      worktree: { mode: "none" },
      message: "Talk about {topic}",
    },
  },
};

function buildRequest(overrides: Partial<LaunchRequest>): LaunchRequest {
  return {
    manifest: SAMPLE_MANIFEST,
    entryPointName: "work-issue",
    projectRoot: PROJECT_ROOT,
    repositoryName: "my-app",
    parameterValues: { issue: "12" },
    effort: undefined,
    baseRef: "origin/main",
    pullRequestWorktree: undefined,
    passthroughArguments: [],
    inheritedPath: INHERITED_PATH,
    ...overrides,
  };
}

describe("buildLaunchPlan — new worktree", () => {
  test("names the worktree from the template, branches from the base ref, runs in the project", () => {
    expect(buildLaunchPlan(buildRequest({}))).toEqual({
      commandWords: [
        "docker",
        "agent",
        "run",
        TEAM_CONFIG_PATH,
        "--agent",
        "root",
        "--worktree=my-app-issue-12",
        "--worktree-base",
        "origin/main",
        "Work issue #12",
      ],
      workingDirectory: PROJECT_ROOT,
      pathEnvironment: `${TEAM_BIN_DIRECTORY}:${INHERITED_PATH}`,
    });
  });

  test("passes the effort as --flavor and passthrough flags before the message", () => {
    const plan = buildLaunchPlan(
      buildRequest({ effort: "low", passthroughArguments: ["--safety", "balanced"] }),
    );
    expect(plan.commandWords.slice(4)).toEqual([
      "--agent",
      "root",
      "--flavor",
      "low",
      "--worktree=my-app-issue-12",
      "--worktree-base",
      "origin/main",
      "--safety",
      "balanced",
      "Work issue #12",
    ]);
  });

  test("refuses to build without a base ref", () => {
    expect(() => buildLaunchPlan(buildRequest({ baseRef: undefined }))).toThrow(
      "entry point 'work-issue' needs a base ref for its new worktree",
    );
  });

  test("refuses a worktree name that would not be one safe path segment", () => {
    expect(() => buildLaunchPlan(buildRequest({ repositoryName: "../escape" }))).toThrow(
      "worktree name '../escape-issue-12' must match",
    );
  });
});

describe("buildLaunchPlan — pull request worktree", () => {
  const pullRequestRequest = { entryPointName: "pr-followup", parameterValues: { pr: "456" } };

  test("asks docker-agent to create the PR worktree when none exists", () => {
    const plan = buildLaunchPlan(
      buildRequest({ ...pullRequestRequest, pullRequestWorktree: { kind: "absent" } }),
    );
    expect(plan.commandWords.slice(4)).toEqual([
      "--agent",
      "followup",
      "--worktree-pr",
      "456",
      "Follow up on PR #456 in my-app",
    ]);
  });

  test("continues in a kept worktree of the same repository", () => {
    const plan = buildLaunchPlan(
      buildRequest({
        ...pullRequestRequest,
        pullRequestWorktree: { kind: "reusable", path: "/home/me/.cagent/worktrees/pr-456" },
      }),
    );
    expect(plan.commandWords.slice(4)).toEqual([
      "--agent",
      "followup",
      "--working-dir",
      "/home/me/.cagent/worktrees/pr-456",
      "Follow up on PR #456 in my-app",
    ]);
    expect(plan.commandWords).not.toContain("--worktree-pr");
  });

  test("refuses when the PR worktree path belongs to another repository", () => {
    expect(() =>
      buildLaunchPlan(
        buildRequest({
          ...pullRequestRequest,
          pullRequestWorktree: { kind: "foreign", path: "/home/me/.cagent/worktrees/pr-456" },
        }),
      ),
    ).toThrow("/home/me/.cagent/worktrees/pr-456 belongs to another repository");
  });

  test("refuses to build without the PR worktree state", () => {
    expect(() => buildLaunchPlan(buildRequest(pullRequestRequest))).toThrow(
      "entry point 'pr-followup' needs a PR number and the PR worktree state",
    );
  });
});

describe("buildLaunchPlan — no worktree", () => {
  test("adds no worktree flags and ignores a base ref", () => {
    const plan = buildLaunchPlan(
      buildRequest({ entryPointName: "chat", parameterValues: { topic: "flavors" } }),
    );
    expect(plan.commandWords.slice(4)).toEqual(["--agent", "root", "Talk about flavors"]);
  });
});

describe("buildLaunchPlan — environment", () => {
  test("uses only the team's directories when the inherited PATH is empty", () => {
    expect(buildLaunchPlan(buildRequest({ inheritedPath: "" })).pathEnvironment).toBe(
      TEAM_BIN_DIRECTORY,
    );
  });

  test("rejects an entry point the manifest does not have", () => {
    expect(() => buildLaunchPlan(buildRequest({ entryPointName: "deploy" }))).toThrow(
      "team 'sample-team' has no entry point 'deploy'",
    );
  });
});
