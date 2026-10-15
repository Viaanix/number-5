// Tests for skills/j5-test-quality/scripts/check-test-quality.ts, the pre-screen the
// tester runs. Fixtures are real directories and git repositories; the script runs
// as a subprocess, as agents and CI run it. Kept outside the skill directory so the
// installer does not copy tests into ~/.agents/skills.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import {
  createTemporaryDirectory,
  removeTemporaryDirectories,
  runGit,
} from "#launcher-test/fixtures.ts";

afterAll(removeTemporaryDirectories);

const SCRIPT_PATH = resolve(
  import.meta.dir,
  "..",
  "skills",
  "j5-test-quality",
  "scripts",
  "check-test-quality.ts",
);
const STRICT_FAILURE_EXIT_CODE = 1;
const SCRIPT_ERROR_EXIT_CODE = 2;

// The --json report, validated so a malformed report fails the test instead of
// being read as if it were well formed.
const jsonReportSchema = z.strictObject({
  version: z.string(),
  files_scanned: z.number(),
  findings: z.array(
    z.strictObject({
      severity: z.enum(["HIGH", "MEDIUM", "LOW"]),
      check: z.string(),
      file: z.string(),
      line: z.number(),
      description: z.string(),
    }),
  ),
});
type JsonReport = z.infer<typeof jsonReportSchema>;
type ScriptResult = { exitCode: number; standardOutput: string; standardError: string };

function writeFiles(root: string, filesByPath: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(filesByPath)) {
    const absolutePath = join(root, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  }
}

function runScript(scriptArguments: string[], workingDirectory: string): ScriptResult {
  const completedProcess = Bun.spawnSync(["bun", SCRIPT_PATH, ...scriptArguments], {
    cwd: workingDirectory,
    stdin: "ignore",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    exitCode: completedProcess.exitCode,
    standardOutput: completedProcess.stdout.toString(),
    standardError: completedProcess.stderr.toString(),
  };
}

function runJson(scriptArguments: string[], workingDirectory: string): JsonReport {
  const result = runScript(["--json", ...scriptArguments], workingDirectory);
  return jsonReportSchema.parse(JSON.parse(result.standardOutput));
}

// "check file:line" for each finding, sorted, so tests read as a list of signals.
function signals(report: JsonReport): string[] {
  return report.findings
    .map((finding) => `${finding.check} ${finding.file}:${finding.line}`)
    .toSorted();
}

describe("directory mode", () => {
  test("flags each fig-leaf pattern on its own line, and only in test files", () => {
    const root = createTemporaryDirectory();
    writeFiles(root, {
      "a.test.ts": [
        'test.skip("skipped", () => {});',
        'it.only("focused", () => {});',
        'describe.todo("later");',
        "// @ts-ignore",
        "const value = 1; // @ts-expect-error",
        "expect(value).toBeDefined();",
        "expect(value).toBeTruthy();",
        "expect(run).not.toThrow();",
        "try { run(); } catch (error) {}",
        "try { run(); } catch { }",
      ].join("\n"),
      "b.spec.js": 'it.skip("b", () => {});\n',
      "src/not-a-test.ts": 'test.skip("ignored: not a test file", () => {});\n',
      "node_modules/pkg/dependency.test.ts": 'test.skip("ignored: dependency", () => {});\n',
    });
    expect(signals(runJson(["."], root))).toEqual([
      "disabled-tests ./a.test.ts:1",
      "disabled-tests ./a.test.ts:2",
      "disabled-tests ./a.test.ts:3",
      "disabled-tests ./b.spec.js:1",
      "swallowed-errors ./a.test.ts:10",
      "swallowed-errors ./a.test.ts:9",
      "ts-suppression ./a.test.ts:4",
      "ts-suppression ./a.test.ts:5",
      "weak-assertions ./a.test.ts:6",
      "weak-assertions ./a.test.ts:7",
      "weak-assertions ./a.test.ts:8",
    ]);
  });

  // The bash original split grep output on ':' and grep omits the file name when
  // given one file, so a check with exactly one candidate file reported the line
  // number as the file and the line's text as the line number.
  test("reports file and line correctly when a check has exactly one file", () => {
    const root = createTemporaryDirectory();
    writeFiles(root, { "only.test.ts": '// @ts-ignore\ntest.skip("a", () => {});\n' });
    expect(runJson(["."], root).findings).toEqual([
      {
        severity: "HIGH",
        check: "disabled-tests",
        file: "./only.test.ts",
        line: 2,
        description:
          ".skip() on test — committed disabled test, must have tracking issue or be re-enabled",
      },
      {
        severity: "HIGH",
        check: "ts-suppression",
        file: "./only.test.ts",
        line: 1,
        description:
          "@ts-ignore in test — prefer @ts-expect-error (fails when no longer needed); investigate the underlying type issue",
      },
    ]);
  });

  // The rg path of the bash original skipped hidden directories, so the
  // .github/workflows entry of its own config pattern never matched.
  test("finds an auto-update snapshot flag in package.json and in .github/workflows", () => {
    const root = createTemporaryDirectory();
    writeFiles(root, {
      "a.test.ts": 'test("a", () => {});\n',
      "package.json": '{ "scripts": { "test": "vitest run -u --coverage" } }\n',
      ".github/workflows/ci.yml": "steps:\n  - run: bun test --update-snapshots\n",
    });
    expect(signals(runJson(["."], root))).toEqual([
      "snapshot-auto-update ./.github/workflows/ci.yml:2",
      "snapshot-auto-update ./package.json:1",
    ]);
  });

  test("warns and reports zero files when the target holds no tests", () => {
    const root = createTemporaryDirectory();
    writeFiles(root, { "src/index.ts": "export {};\n" });
    const result = runScript(["src"], root);
    expect(result).toEqual({
      exitCode: 0,
      standardOutput: "check-test-quality: no findings (0 test file(s) scanned)\n",
      standardError:
        "warning: no test files matched in target 'src' — verify the path is correct and contains files matching common test patterns (*.test.ts, *.spec.js, *_test.go, etc.).\n",
    });
  });
});

// A repository whose second commit changes one test, adds one, regenerates a snapshot
// without touching its source, and drops a coverage threshold from a JS config.
function createChangedRepository(): { root: string; baseCommit: string } {
  const root = createTemporaryDirectory();
  runGit(root, ["init", "--quiet", "-b", "main"]);
  writeFiles(root, {
    "x.test.ts": 'test("x", () => {});\n',
    "unchanged.test.ts": 'test.skip("old, not in the diff", () => {});\n',
    "src/__snapshots__/comp.test.ts.snap": "exports[`a`] = `1`;\n",
    "jest.config.js": "module.exports = { coverageThreshold: { global: {\n  lines: 80,\n} } };\n",
  });
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "--quiet", "-m", "base"]);
  const baseCommit = runGit(root, ["rev-parse", "HEAD"]);
  writeFiles(root, {
    "x.test.ts": 'test("x", () => {});\nit.only("focus", () => {});\n',
    "y.test.ts": 'test.skip("new", () => {});\n',
    "src/__snapshots__/comp.test.ts.snap": "exports[`a`] = `2`;\n",
    "jest.config.js": "module.exports = { coverageThreshold: { global: {\n} } };\n",
  });
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "--quiet", "-m", "change"]);
  return { root, baseCommit };
}

describe("diff mode", () => {
  test("checks only changed tests, plus regenerated snapshots and lowered coverage", () => {
    const { root, baseCommit } = createChangedRepository();
    const report = runJson(["--diff", `${baseCommit}..HEAD`], root);
    expect(report.files_scanned).toBe(2);
    expect(signals(report)).toEqual([
      "coverage-regression jest.config.js:0",
      "disabled-tests x.test.ts:2",
      "disabled-tests y.test.ts:1",
      "snapshot-auto-update src/__snapshots__/comp.test.ts.snap:0",
    ]);
  });

  test("--strict exits 1 on a HIGH finding; without --strict it exits 0", () => {
    const { root, baseCommit } = createChangedRepository();
    expect(runScript(["--diff", `${baseCommit}..HEAD`], root).exitCode).toBe(0);
    expect(runScript(["--diff", `${baseCommit}..HEAD`, "--strict"], root).exitCode).toBe(
      STRICT_FAILURE_EXIT_CODE,
    );
  });
});

describe("arguments", () => {
  test.each([
    [["--diff"], "error: --diff requires a range argument\n"],
    [["--check"], "error: --check requires a list argument\n"],
  ])("%p is a script error", (scriptArguments, expectedError) => {
    const result = runScript(scriptArguments, createTemporaryDirectory());
    expect(result.exitCode).toBe(SCRIPT_ERROR_EXIT_CODE);
    expect(result.standardError).toBe(expectedError);
  });

  test("an unknown flag is a script error that shows usage", () => {
    const result = runScript(["--nope"], createTemporaryDirectory());
    expect(result.exitCode).toBe(SCRIPT_ERROR_EXIT_CODE);
    expect(result.standardError).toStartWith("error: unknown flag --nope\ncheck-test-quality.ts v");
  });

  test("an unknown check is skipped with a warning; the others still run", () => {
    const root = createTemporaryDirectory();
    writeFiles(root, {
      "a.test.ts": 'test.skip("a", () => {});\nexpect(a).toBeTruthy();\n',
      "b.test.ts": "",
    });
    const result = runScript(["--json", "--check", "weak-assertions, nope", "."], root);
    expect(result.standardError).toBe("warning: unknown check 'nope' — skipping\n");
    expect(signals(jsonReportSchema.parse(JSON.parse(result.standardOutput)))).toEqual([
      "weak-assertions ./a.test.ts:2",
    ]);
  });
});
