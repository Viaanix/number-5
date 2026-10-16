// test-quality-write-report: writes the audit report, which docker-agent's write_report
// tool passes in the environment variable `content`, to
// `<cwd>/.j5/review/test-quality-audit-<YYYY-MM-DD>.md` (today's local date).
// An existing report is never overwritten: the name gets `-2`, `-3`, ... before `.md`.
// Prints the path it wrote. The auditor has no file-writing tool, so this helper is the
// only way it can create a file, and it can only create files in that one directory.
//
// Report text over MAXIMUM_REPORT_CHARACTERS is refused: it travels as an environment
// variable, whose size the operating system limits (a single variable on Linux is capped
// near 128 KiB, and Windows caps the whole environment lower still).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HelperUsageError, readToolArgument, runHelper } from "#launcher/team-helper.ts";

export const REPORT_DIRECTORY_SEGMENTS = [".j5", "review"] as const;
export const MAXIMUM_REPORT_CHARACTERS = 30_000;
const REPORT_NAME_PREFIX = "test-quality-audit-";
const REPORT_NAME_EXTENSION = ".md";
const FIRST_DUPLICATE_NUMBER = 2;

/** Today's date in the user's time zone as YYYY-MM-DD (toISOString would give UTC's). */
export function formatLocalDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * The first report file name for `date` that `isTaken` does not report as existing:
 * `test-quality-audit-<date>.md`, then `-2.md`, `-3.md`, ...
 */
export function chooseReportFileName(date: string, isTaken: (fileName: string) => boolean): string {
  const baseName = `${REPORT_NAME_PREFIX}${date}`;
  let candidate = `${baseName}${REPORT_NAME_EXTENSION}`;
  for (let duplicateNumber = FIRST_DUPLICATE_NUMBER; isTaken(candidate); duplicateNumber += 1) {
    candidate = `${baseName}-${duplicateNumber}${REPORT_NAME_EXTENSION}`;
  }
  return candidate;
}

/** Throws a usage error unless `content` is a non-blank report within the size limit. */
export function assertReportContent(content: string | undefined): asserts content is string {
  if (content === undefined || content.trim() === "") {
    throw new HelperUsageError("content is required: the report text, not empty");
  }
  if (content.length > MAXIMUM_REPORT_CHARACTERS) {
    throw new HelperUsageError(
      `content is ${content.length} characters; the limit is ${MAXIMUM_REPORT_CHARACTERS}. Shorten the report: group findings, cite each file:line once.`,
    );
  }
}

/**
 * Writes the report under `<projectRoot>/.j5/review/` and returns the path written.
 * The `wx` flag makes the create fail rather than overwrite if another run took the name
 * between the existence check and the write.
 */
export function writeAuditReport(projectRoot: string, content: string, now: Date): string {
  assertReportContent(content);
  const reportDirectory = join(projectRoot, ...REPORT_DIRECTORY_SEGMENTS);
  mkdirSync(reportDirectory, { recursive: true });
  const fileName = chooseReportFileName(formatLocalDate(now), (candidate) =>
    existsSync(join(reportDirectory, candidate)),
  );
  const reportPath = join(reportDirectory, fileName);
  writeFileSync(reportPath, content.endsWith("\n") ? content : `${content}\n`, { flag: "wx" });
  return reportPath;
}

if (import.meta.main) {
  runHelper("test-quality-write-report", () => {
    console.log(writeAuditReport(process.cwd(), readToolArgument("content") ?? "", new Date()));
  });
}
