// Tests for test-quality-write-report (helpers/write-report.ts, launched from bin/): the
// auditor's only way to create a file. Pure name logic is tested directly; the rest runs
// the helper the way a docker-agent script tool does, with the report in the environment.

import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  createTemporaryDirectory,
  DOCKER_AGENT_SHELLS,
  type HelperResult,
  removeTemporaryDirectories,
  runHelperScriptFile,
  runThroughDockerAgentShell,
} from "#launcher-test/fixtures.ts";

import {
  chooseReportFileName,
  formatLocalDate,
  MAXIMUM_REPORT_CHARACTERS,
} from "../helpers/write-report.ts";

afterAll(removeTemporaryDirectories);

const TEAM_DIRECTORY = resolve(import.meta.dir, "..");
const USAGE_EXIT_CODE = 2;
const TODAY_PATTERN = /test-quality-audit-\d{4}-\d{2}-\d{2}(-\d+)?\.md$/;

function runWriteReport(
  projectRoot: string,
  reportContent: string | undefined,
  commandLineArguments: string[] = [],
): HelperResult {
  return runHelperScriptFile(
    join(TEAM_DIRECTORY, "helpers", "write-report.ts"),
    commandLineArguments,
    projectRoot,
    reportContent === undefined ? {} : { content: reportContent },
  );
}

function listReports(projectRoot: string): string[] {
  const reportDirectory = join(projectRoot, ".j5", "review");
  return existsSync(reportDirectory) ? readdirSync(reportDirectory).toSorted() : [];
}

describe("chooseReportFileName", () => {
  // Catches a first report that already carries a suffix, or a date format other than the
  // one the auditor's instructions promise.
  test("the first report of a day has no suffix", () => {
    expect(chooseReportFileName("2026-10-15", () => false)).toBe(
      "test-quality-audit-2026-10-15.md",
    );
  });

  // Catches an off-by-one that starts duplicates at -1 or repeats -2, which would overwrite
  // or collide with the second report.
  test("skips taken names with -2, -3, ... before the extension", () => {
    const taken: Record<string, true> = {
      "test-quality-audit-2026-10-15.md": true,
      "test-quality-audit-2026-10-15-2.md": true,
    };
    expect(chooseReportFileName("2026-10-15", (name) => name in taken)).toBe(
      "test-quality-audit-2026-10-15-3.md",
    );
  });
});

describe("formatLocalDate", () => {
  // Catches toISOString(): it is UTC, so a late-evening run west of Greenwich (or an early
  // one east of it) would date the report with the wrong day.
  test("uses the local calendar day, zero-padded", () => {
    expect(formatLocalDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

describe("test-quality-write-report", () => {
  // Catches a helper that writes somewhere else, forgets to create .j5/review/, or does not
  // print the path the agent must report.
  test("creates .j5/review and prints the path it wrote", () => {
    const projectRoot = createTemporaryDirectory();
    const result = runWriteReport(projectRoot, "# Audit\nS1 finding\n");
    expect(result.exitCode).toBe(0);
    const writtenPath = result.standardOutput.trim();
    // The helper prints the path of its real working directory; macOS temporary directories sit
    // behind a symlink (/var -> /private/var), so compare against the canonical form.
    const canonicalProjectRoot = realpathSync.native(projectRoot);
    expect(writtenPath.startsWith(join(canonicalProjectRoot, ".j5", "review"))).toBe(true);
    expect(writtenPath).toMatch(TODAY_PATTERN);
    expect(readFileSync(writtenPath, "utf8")).toBe("# Audit\nS1 finding\n");
  });

  // Catches an overwrite: the second audit of a day would destroy the first, which the
  // workflow forbids. Also checks each run gets a new name.
  test("a second and third report get -2 and -3 and leave the first intact", () => {
    const projectRoot = createTemporaryDirectory();
    const first = runWriteReport(projectRoot, "first report").standardOutput.trim();
    const second = runWriteReport(projectRoot, "second report").standardOutput.trim();
    const third = runWriteReport(projectRoot, "third report").standardOutput.trim();
    expect(second).toBe(first.replace(/\.md$/, "-2.md"));
    expect(third).toBe(first.replace(/\.md$/, "-3.md"));
    expect(readFileSync(first, "utf8")).toBe("first report\n");
    expect(readFileSync(second, "utf8")).toBe("second report\n");
    expect(readFileSync(third, "utf8")).toBe("third report\n");
  });

  // Catches a helper that treats an existing .j5/review directory (the second run, or a
  // project that already has other reports) as an error, or clobbers the files in it.
  test("keeps unrelated files already in .j5/review", () => {
    const projectRoot = createTemporaryDirectory();
    const reportDirectory = join(projectRoot, ".j5", "review");
    mkdirSync(reportDirectory, { recursive: true });
    writeFileSync(join(reportDirectory, "notes.md"), "keep me");
    const result = runWriteReport(projectRoot, "report");
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(reportDirectory, "notes.md"), "utf8")).toBe("keep me");
    expect(listReports(projectRoot)).toHaveLength(2);
  });

  // Catches an empty or whitespace-only report being written: the agent would believe it
  // delivered the audit while the user finds an empty file.
  test.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "  \n\t\n"],
  ])("refuses %s content and writes nothing", (_label, reportContent) => {
    const projectRoot = createTemporaryDirectory();
    const result = runWriteReport(projectRoot, reportContent);
    expect(result.exitCode).toBe(USAGE_EXIT_CODE);
    expect(result.standardError).toContain("content is required");
    expect(listReports(projectRoot)).toEqual([]);
  });

  // Catches the size limit being dropped: an oversized environment variable fails the exec
  // of the helper with an opaque OS error instead of a message the agent can act on.
  test("refuses content over the limit, naming the count, and writes nothing", () => {
    const projectRoot = createTemporaryDirectory();
    const result = runWriteReport(projectRoot, "x".repeat(MAXIMUM_REPORT_CHARACTERS + 1));
    expect(result.exitCode).toBe(USAGE_EXIT_CODE);
    expect(result.standardError).toContain(`${MAXIMUM_REPORT_CHARACTERS + 1} characters`);
    expect(listReports(projectRoot)).toEqual([]);
  });

  // Catches an off-by-one on the limit: a report of exactly the maximum is accepted.
  test("accepts content of exactly the limit", () => {
    const projectRoot = createTemporaryDirectory();
    const result = runWriteReport(projectRoot, "x".repeat(MAXIMUM_REPORT_CHARACTERS));
    expect(result.exitCode).toBe(0);
    expect(listReports(projectRoot)).toHaveLength(1);
  });

  // Catches report text steering the destination: the file name is derived only from the
  // date, so content (or an argument) that looks like a path writes nothing outside
  // .j5/review. The auditor's text comes from reading untrusted test files.
  test("never writes outside .j5/review, whatever the content or arguments say", () => {
    const projectRoot = createTemporaryDirectory();
    const parentDirectory = resolve(projectRoot, "..");
    const before = readdirSync(parentDirectory).toSorted();
    const result = runWriteReport(projectRoot, "../../escape.md\n/etc/passwd\n", ["../escape.md"]);
    expect(result.exitCode).toBe(0);
    expect(readdirSync(parentDirectory).toSorted()).toEqual(before);
    expect(readdirSync(projectRoot).toSorted()).toEqual([".j5"]);
    expect(listReports(projectRoot)).toHaveLength(1);
  });
});

describe.each(DOCKER_AGENT_SHELLS)(
  "test-quality-write-report by bare name through $shellName",
  ({ commandPrefix }) => {
    // Catches a launcher (sh or .cmd) that drops the environment, loses the working
    // directory, or is not executable: the tool must work as docker-agent calls it.
    test("writes the report from the environment", () => {
      const projectRoot = createTemporaryDirectory();
      const result = runThroughDockerAgentShell(
        commandPrefix,
        join(TEAM_DIRECTORY, "bin"),
        "test-quality-write-report",
        projectRoot,
        { content: "bare report" },
      );
      expect(result.exitCode).toBe(0);
      expect(listReports(projectRoot)).toHaveLength(1);
    });
  },
);
