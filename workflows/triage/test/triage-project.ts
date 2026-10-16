// A real git repository with the fake GitHub from fixtures/gh.ts in front of it, and runners for
// the two helpers. Only GitHub is simulated; every git command is real.
import { readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

import { z } from "zod";

import {
  createFixtureProject,
  createTemporaryDirectory,
  runHelperScriptFile,
  writeFakeCommand,
  type HelperResult,
} from "#launcher-test/fixtures.ts";
import { findPathVariableName, readPathValue } from "#launcher/environment.ts";

import type { FakeIssue, FakeState } from "./fixtures/gh.ts";

const TEAM_DIRECTORY = resolve(import.meta.dir, "..");
const CONTEXT_HELPER_PATH = join(TEAM_DIRECTORY, "helpers", "context.ts");
const APPLY_HELPER_PATH = join(TEAM_DIRECTORY, "helpers", "apply.ts");

export const ISSUE_NUMBER = 12;
export const REPOSITORY_NAME = "example/triage-app";

export function createIssueRecord(overrides: Partial<FakeIssue> = {}): FakeIssue {
  const number = overrides.number ?? ISSUE_NUMBER;
  return {
    number,
    restId: 9000 + number,
    title: "Login fails after the password reset",
    body: "After resetting my password I cannot log in. Please fix.",
    state: "OPEN",
    url: `https://github.com/${REPOSITORY_NAME}/issues/${number}`,
    createdAt: "2026-10-15T09:00:00Z",
    updatedAt: "2026-10-15T09:00:00Z",
    author: { login: "reporter" },
    authorAssociation: "MEMBER",
    labels: ["bug"],
    comments: [],
    parent: null,
    subIssueNumbers: [],
    isPullRequest: false,
    ...overrides,
  };
}

export type TriageProject = {
  projectRoot: string;
  /** Runs triage_context; the issue defaults to ISSUE_NUMBER. */
  runContext(extraEnvironment?: Record<string, string>): HelperResult;
  /** Runs triage_apply with these tool arguments (and any extra environment, such as the dry run). */
  runApply(
    toolArguments: Record<string, string>,
    extraEnvironment?: Record<string, string>,
  ): HelperResult;
  state(): FakeState;
  update(change: (state: FakeState) => void): void;
  /** The gh calls that change something on GitHub, in order, as `gh <command> <subcommand>`. */
  writeCalls(): string[];
};

const READ_ONLY_CALLS = new Set(["repo view", "issue view", "label list"]);

export function createTriageProject(): TriageProject {
  const { projectRoot } = createFixtureProject("triage-app");
  const commandDirectory = createTemporaryDirectory();
  const statePath = join(commandDirectory, "github-state.json");
  const initialState: FakeState = {
    repository: { nameWithOwner: REPOSITORY_NAME, defaultBranch: "trunk", isArchived: false },
    issues: { [String(ISSUE_NUMBER)]: createIssueRecord() },
    labels: [{ name: "bug", color: "d73a4a", description: "Something isn't working" }],
    nextIssueNumber: 100,
    nextRestId: 5000,
    calls: [],
    failIssueCreateNumber: undefined,
  };
  writeFileSync(statePath, JSON.stringify(initialState));
  writeFakeCommand(commandDirectory, "gh", join(import.meta.dir, "fixtures", "gh.ts"));
  const environment = {
    [findPathVariableName(process.env)]:
      `${commandDirectory}${delimiter}${readPathValue(process.env)}`,
    TRIAGE_GH_STATE: statePath,
    // A developer's own setting must not turn every test into a dry run.
    J5_TRIAGE_DRY_RUN: "",
  };
  const state = (): FakeState =>
    z.custom<FakeState>().parse(JSON.parse(readFileSync(statePath, "utf8")));
  return {
    projectRoot,
    runContext: (extraEnvironment = {}) =>
      runHelperScriptFile(CONTEXT_HELPER_PATH, [], projectRoot, {
        ...environment,
        issue: String(ISSUE_NUMBER),
        ...extraEnvironment,
      }),
    runApply: (toolArguments, extraEnvironment = {}) =>
      runHelperScriptFile(APPLY_HELPER_PATH, [], projectRoot, {
        ...environment,
        issue: String(ISSUE_NUMBER),
        ...toolArguments,
        ...extraEnvironment,
      }),
    state,
    update: (change) => {
      const current = state();
      change(current);
      writeFileSync(statePath, JSON.stringify(current));
    },
    writeCalls: () =>
      state()
        .calls.map((call) => `${call[0]} ${call[1]}`)
        .filter((call) => !READ_ONLY_CALLS.has(call) && !call.startsWith("api repos/")),
  };
}
