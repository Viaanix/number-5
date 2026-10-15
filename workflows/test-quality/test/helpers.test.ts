// Tests for the test-quality helpers (workflows/test-quality/helpers, launched by its
// bin/). They run against real temporary repositories. The shared logic behind them
// (launcher/src/change-diff.ts, launcher/src/test-prescreen.ts) is covered in depth
// by the issue-team helper tests; these pin what this team's helpers add: the
// target argument of the pre-screen, and change-diff's fixed full scope.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  createFixtureProject,
  DOCKER_AGENT_SHELLS,
  FIXTURE_DEFAULT_BRANCH,
  type HelperResult,
  removeTemporaryDirectories,
  runGit,
  runHelperScriptFile,
  runThroughDockerAgentShell,
} from "#launcher-test/fixtures.ts";

afterAll(removeTemporaryDirectories);

const TEAM_DIRECTORY = resolve(import.meta.dir, "..");
const TEAM_BIN_DIRECTORY = join(TEAM_DIRECTORY, "bin");
const NO_HIGH_FINDINGS_EXIT_CODE = 0;
const HIGH_FINDINGS_EXIT_CODE = 1;
const USAGE_EXIT_CODE = 2;
const FOCUSED_TEST_SOURCE = 'it.only("focused", () => {});\n';
const CLEAN_TEST_SOURCE =
  'import { expect, test } from "bun:test";\ntest("adds", () => {\n  expect(1 + 1).toBe(2);\n});\n';

function runHelperScript(
  helperName: string,
  helperArguments: string[],
  workingDirectory: string,
  extraEnvironment: Record<string, string> = {},
): HelperResult {
  return runHelperScriptFile(
    join(TEAM_DIRECTORY, "helpers", `${helperName}.ts`),
    helperArguments,
    workingDirectory,
    extraEnvironment,
  );
}

// A clone on a feature branch where the default branch already holds
// `legacy/focused.test.ts` with `.only` (committed before the branch, so not part of
// the branch's change) and `clean/adds.test.ts` without findings. The branch itself
// adds one commit that touches no test file.
function createProjectWithLegacyFindings(repositoryName: string): string {
  const { projectRoot } = createFixtureProject(repositoryName);
  mkdirSync(join(projectRoot, "legacy"));
  mkdirSync(join(projectRoot, "clean"));
  writeFileSync(join(projectRoot, "legacy", "focused.test.ts"), FOCUSED_TEST_SOURCE);
  writeFileSync(join(projectRoot, "clean", "adds.test.ts"), CLEAN_TEST_SOURCE);
  runGit(projectRoot, ["add", "."]);
  runGit(projectRoot, ["commit", "--quiet", "-m", "existing tests"]);
  runGit(projectRoot, ["push", "--quiet", "origin", FIXTURE_DEFAULT_BRANCH]);
  runGit(projectRoot, ["checkout", "--quiet", "-b", "feature"]);
  writeFileSync(join(projectRoot, "notes.txt"), "not a test\n");
  runGit(projectRoot, ["add", "notes.txt"]);
  runGit(projectRoot, ["commit", "--quiet", "-m", "add notes"]);
  return projectRoot;
}

describe("test-quality-prescreen", () => {
  // Catches a target that is ignored: without it the scan falls back to the branch's
  // changes, which hold no test file, and the committed `.only` goes unreported.
  test("with a target, scans every test file under it, changed or not", () => {
    const projectRoot = createProjectWithLegacyFindings("prescreen-target-app");
    const result = runHelperScript("prescreen", ["legacy"], projectRoot);
    expect(result.exitCode).toBe(HIGH_FINDINGS_EXIT_CODE);
    expect(result.standardOutput).toContain("[HIGH] disabled-tests  legacy/focused.test.ts:1\n");
  });

  // Catches a target that is widened to the whole checkout.
  test("with a target, scans nothing outside it", () => {
    const projectRoot = createProjectWithLegacyFindings("prescreen-narrow-app");
    const result = runHelperScript("prescreen", ["clean"], projectRoot);
    expect(result.exitCode).toBe(NO_HIGH_FINDINGS_EXIT_CODE);
    expect(result.standardOutput).not.toContain("legacy/focused.test.ts");
  });

  // Catches the no-target case scanning the whole checkout (e.g. defaulting the
  // target to "."), which would charge the branch with findings it did not make.
  test("without a target, scans only the test files the branch changed", () => {
    const projectRoot = createProjectWithLegacyFindings("prescreen-changes-app");
    writeFileSync(join(projectRoot, "new.test.ts"), FOCUSED_TEST_SOURCE);
    runGit(projectRoot, ["add", "-N", "new.test.ts"]);
    const result = runHelperScript("prescreen", [], projectRoot);
    expect(result.exitCode).toBe(HIGH_FINDINGS_EXIT_CODE);
    expect(result.standardOutput).toContain("[HIGH] disabled-tests  new.test.ts:1\n");
    expect(result.standardOutput).not.toContain("legacy/focused.test.ts");
  });

  // Catches a target passed through as one of the pre-screen script's own options,
  // e.g. `--check` narrowing the checks, instead of being refused.
  test("refuses a target that looks like an option", () => {
    const projectRoot = createProjectWithLegacyFindings("prescreen-option-app");
    const result = runHelperScript("prescreen", ["--json"], projectRoot);
    expect(result).toEqual({
      exitCode: USAGE_EXIT_CODE,
      standardOutput: "",
      standardError:
        "test-quality-prescreen: target must be a file or directory, not an option: --json\n",
    });
  });
});

describe("test-quality-change-diff", () => {
  // Catches the helper reading `since` from its environment like issue-team's does:
  // review-branch always reviews the whole change.
  test("prints the full change even when since is set in the environment", () => {
    const projectRoot = createProjectWithLegacyFindings("change-diff-app");
    const firstFeatureCommit = runGit(projectRoot, ["rev-parse", "--short", "HEAD"]);
    const result = runHelperScript("change-diff", [], projectRoot, { since: firstFeatureCommit });
    expect(result.exitCode).toBe(0);
    expect(result.standardOutput).toStartWith(
      `scope: full\nbase: origin/${FIXTURE_DEFAULT_BRANCH}  merge-base: `,
    );
    expect(result.standardOutput).toContain("add notes");
    expect(result.standardOutput).not.toContain("existing tests");
  });
});

describe.each(DOCKER_AGENT_SHELLS)(
  "helpers by bare name through $shellName",
  ({ commandPrefix }) => {
    function runThroughShell(
      command: string,
      workingDirectory: string,
      extraEnvironment: Record<string, string> = {},
    ): HelperResult {
      return runThroughDockerAgentShell(
        commandPrefix,
        TEAM_BIN_DIRECTORY,
        command,
        workingDirectory,
        extraEnvironment,
      );
    }

    // Catches a launcher that drops the environment argument, and (on Windows) an
    // argument name that collides with PATH: the helper must still start and run git.
    test("test-quality-prescreen with target in the environment", () => {
      const projectRoot = createProjectWithLegacyFindings("bare-prescreen-app");
      const result = runThroughShell("test-quality-prescreen", projectRoot, { target: "legacy" });
      expect(result.exitCode).toBe(HIGH_FINDINGS_EXIT_CODE);
      expect(result.standardOutput).toContain("[HIGH] disabled-tests  legacy/focused.test.ts:1\n");
    });

    test("test-quality-change-diff", () => {
      const projectRoot = createProjectWithLegacyFindings("bare-change-diff-app");
      const result = runThroughShell("test-quality-change-diff", projectRoot);
      expect(result.exitCode).toBe(0);
      expect(result.standardOutput).toStartWith("scope: full\n");
    });
  },
);
