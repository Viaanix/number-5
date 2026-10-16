import { describe, expect, test } from "bun:test";
import { delimiter, dirname, join } from "node:path";

import type { WorkflowManifest } from "../src/manifest.ts";
import { buildLaunchPlan, type LaunchRequest } from "../src/plan.ts";

const TEAM_CONFIG_PATH = "/teams/sample/team.yaml";
const TEAM_BIN_DIRECTORY = "/teams/sample/bin";
const PROJECT_ROOT = "/code/my-app";
const INHERITED_PATH = "/usr/local/bin:/usr/bin";
// Worktrees go beside the project. join() so the expectations hold on Windows too.
const NEW_WORKTREE_PATH = join(dirname(PROJECT_ROOT), "my-app-issue-12");
const PULL_REQUEST_WORKTREE_PATH = join(dirname(PROJECT_ROOT), "my-app-pr-456");

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
      queue: {
        parameter: "issue",
        preamble: "Queue item {position} of {count} in {repo}: {round_limit}.",
      },
    },
    "pr-followup": {
      description: "d",
      agent: "followup",
      parameters: { pr: { type: "integer", label: "PR" } },
      worktree: { mode: "pr", pull_request_parameter: "pr" },
      message: "Follow up on PR #{pr} in {repo}",
    },
    "pr-review": {
      description: "d",
      agent: "reviewer",
      parameters: { pr: { type: "integer", label: "PR" } },
      worktree: { mode: "pr", pull_request_parameter: "pr", detached: true },
      message: "Review PR #{pr} in {repo}",
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
    automaticFlavors: [],
    baseRef: "origin/main",
    worktree: { state: { kind: "absent" }, pullRequestBranch: undefined },
    queueItem: undefined,
    passthroughArguments: [],
    inheritedPath: INHERITED_PATH,
    ...overrides,
  };
}

describe("buildLaunchPlan — new worktree", () => {
  // Catches docker-agent's --worktree coming back: it leaves a Claude Code harness
  // agent in the user's checkout. The agent must start inside the new worktree.
  test("creates the worktree beside the project from the fetched base, then runs docker-agent inside it", () => {
    expect(buildLaunchPlan(buildRequest({}))).toEqual({
      preparationSteps: [
        ["git", "-C", PROJECT_ROOT, "fetch", "origin", "main"],
        [
          "git",
          "-C",
          PROJECT_ROOT,
          "worktree",
          "add",
          "-b",
          "worktree-my-app-issue-12",
          NEW_WORKTREE_PATH,
          "origin/main",
        ],
      ],
      commandWords: [
        "docker",
        "agent",
        "run",
        TEAM_CONFIG_PATH,
        "--agent",
        "root",
        "--working-dir",
        NEW_WORKTREE_PATH,
        "Work issue #12",
      ],
      workingDirectory: NEW_WORKTREE_PATH,
      pathEnvironment: `${TEAM_BIN_DIRECTORY}${delimiter}${INHERITED_PATH}`,
    });
  });

  // Catches the reviewer's flavor being applied before the effort: docker-agent applies flavors
  // in order, so the reviewer's tier patch must land on the models the effort already set.
  test("passes the automatic flavors after the effort flavor, in order", () => {
    const plan = buildLaunchPlan(
      buildRequest({ effort: "low", automaticFlavors: ["reviewer-on-sonnet"] }),
    );
    expect(plan.commandWords.slice(0, 10)).toEqual([
      "docker",
      "agent",
      "run",
      TEAM_CONFIG_PATH,
      "--agent",
      "root",
      "--flavor",
      "low",
      "--flavor",
      "reviewer-on-sonnet",
    ]);
  });

  test("adds only the automatic flavor when no effort was chosen", () => {
    const plan = buildLaunchPlan(buildRequest({ automaticFlavors: ["reviewer-on-opus"] }));
    expect(plan.commandWords.slice(4, 8)).toEqual([
      "--agent",
      "root",
      "--flavor",
      "reviewer-on-opus",
    ]);
  });

  test("fetches only a remote-tracking base; a local ref or SHA is used as it is", () => {
    const plan = buildLaunchPlan(buildRequest({ baseRef: "release-2" }));
    expect(plan.preparationSteps).toEqual([
      [
        "git",
        "-C",
        PROJECT_ROOT,
        "worktree",
        "add",
        "-b",
        "worktree-my-app-issue-12",
        NEW_WORKTREE_PATH,
        "release-2",
      ],
    ]);
  });

  // Catches a resumed run resetting or re-branching work already in the worktree.
  test("continues in an existing worktree of the project without any git step", () => {
    const plan = buildLaunchPlan(
      buildRequest({ worktree: { state: { kind: "reusable" }, pullRequestBranch: undefined } }),
    );
    expect(plan.preparationSteps).toEqual([]);
    expect(plan.workingDirectory).toBe(NEW_WORKTREE_PATH);
    expect(plan.commandWords).toContain(NEW_WORKTREE_PATH);
  });

  test("refuses a path that holds something other than a worktree of the project", () => {
    expect(() =>
      buildLaunchPlan(
        buildRequest({ worktree: { state: { kind: "foreign" }, pullRequestBranch: undefined } }),
      ),
    ).toThrow(`${NEW_WORKTREE_PATH} exists and is not a worktree of ${PROJECT_ROOT}`);
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
      "--working-dir",
      NEW_WORKTREE_PATH,
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

  test("refuses to build without the worktree's state", () => {
    expect(() => buildLaunchPlan(buildRequest({ worktree: undefined }))).toThrow(
      `entry point 'work-issue' needs the state of ${NEW_WORKTREE_PATH}`,
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
  const pullRequestBranch = { name: "feature/login", existsLocally: false };

  // Catches a PR worktree on a detached HEAD or an untracked branch: followup's
  // `git pull --ff-only` and `git push` must update the PR's own branch.
  test("creates a worktree on a new local branch that tracks the PR's branch", () => {
    const plan = buildLaunchPlan(
      buildRequest({
        ...pullRequestRequest,
        worktree: { state: { kind: "absent" }, pullRequestBranch },
      }),
    );
    expect(plan.preparationSteps).toEqual([
      ["git", "-C", PROJECT_ROOT, "fetch", "origin", "feature/login"],
      [
        "git",
        "-C",
        PROJECT_ROOT,
        "worktree",
        "add",
        "--track",
        "-b",
        "feature/login",
        PULL_REQUEST_WORKTREE_PATH,
        "origin/feature/login",
      ],
    ]);
    expect(plan.commandWords.slice(4)).toEqual([
      "--agent",
      "followup",
      "--working-dir",
      PULL_REQUEST_WORKTREE_PATH,
      "Follow up on PR #456 in my-app",
    ]);
    expect(plan.workingDirectory).toBe(PULL_REQUEST_WORKTREE_PATH);
  });

  // Catches `-b` on a branch that already exists locally, which git refuses.
  test("uses an existing local branch of the same name as it is", () => {
    const plan = buildLaunchPlan(
      buildRequest({
        ...pullRequestRequest,
        worktree: {
          state: { kind: "absent" },
          pullRequestBranch: { name: "feature/login", existsLocally: true },
        },
      }),
    );
    expect(plan.preparationSteps[1]).toEqual([
      "git",
      "-C",
      PROJECT_ROOT,
      "worktree",
      "add",
      PULL_REQUEST_WORKTREE_PATH,
      "feature/login",
    ]);
  });

  test("continues in a kept worktree of the same repository", () => {
    const plan = buildLaunchPlan(
      buildRequest({
        ...pullRequestRequest,
        worktree: { state: { kind: "reusable" }, pullRequestBranch: undefined },
      }),
    );
    expect(plan.preparationSteps).toEqual([]);
    expect(plan.workingDirectory).toBe(PULL_REQUEST_WORKTREE_PATH);
  });

  test("refuses when the PR worktree path belongs to another repository", () => {
    expect(() =>
      buildLaunchPlan(
        buildRequest({
          ...pullRequestRequest,
          worktree: { state: { kind: "foreign" }, pullRequestBranch: undefined },
        }),
      ),
    ).toThrow(`${PULL_REQUEST_WORKTREE_PATH} exists and is not a worktree of ${PROJECT_ROOT}`);
  });

  test("refuses to create the worktree without the PR's branch", () => {
    expect(() => buildLaunchPlan(buildRequest(pullRequestRequest))).toThrow(
      "entry point 'pr-followup' needs the PR's branch to create its worktree",
    );
  });

  // Catches a detached review and an attached follow-up of the same PR sharing one
  // path: whichever ran second would clobber (or wrongly reuse) the other's worktree.
  test("gives a detached review and an attached follow-up of the same PR different worktrees", () => {
    const worktree = { state: { kind: "absent" as const }, pullRequestBranch };
    const attached = buildLaunchPlan(buildRequest({ ...pullRequestRequest, worktree }));
    const detached = buildLaunchPlan(
      buildRequest({ entryPointName: "pr-review", parameterValues: { pr: "456" }, worktree }),
    );
    expect(attached.workingDirectory).toBe(PULL_REQUEST_WORKTREE_PATH);
    expect(detached.workingDirectory).toBe(`${PULL_REQUEST_WORKTREE_PATH}-detached`);
  });
});

describe("buildLaunchPlan — queue item", () => {
  // Catches the preamble going missing or after the prompt: it overrides the prompt's
  // "ask the user" steps, so the agent must read it first.
  test("puts the filled preamble before the entry point's message", () => {
    const plan = buildLaunchPlan(
      buildRequest({
        queueItem: { position: 2, count: 3, roundLimitText: "at most 4 fix rounds" },
      }),
    );
    expect(plan.commandWords.at(-1)).toBe(
      "Queue item 2 of 3 in my-app: at most 4 fix rounds.\n\nWork issue #12",
    );
  });

  test("refuses a queue item for an entry point without a queue", () => {
    expect(() =>
      buildLaunchPlan(
        buildRequest({
          entryPointName: "chat",
          parameterValues: { topic: "x" },
          queueItem: { position: 1, count: 1, roundLimitText: "r" },
        }),
      ),
    ).toThrow("entry point 'chat' has no queue");
  });
});

describe("buildLaunchPlan — no worktree", () => {
  test("adds no worktree flags and ignores a base ref", () => {
    const plan = buildLaunchPlan(
      buildRequest({ entryPointName: "chat", parameterValues: { topic: "flavors" } }),
    );
    expect(plan.commandWords.slice(4)).toEqual(["--agent", "root", "Talk about flavors"]);
    expect(plan.preparationSteps).toEqual([]);
    expect(plan.workingDirectory).toBe(PROJECT_ROOT);
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
