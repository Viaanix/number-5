#!/usr/bin/env bun
// check-test-quality.ts
//
// Tier 1 pattern-based pre-screen for test fig-leaf signals. Catches the
// deterministic anti-patterns named in the j5-test-quality skill without LLM
// analysis. Use as a fast pre-screen before declaring tests "done" or as a CI
// gating check. Tier 2 (LLM-based adversarial review) should still run for the
// deeper checks.
//
// A TypeScript port of check-test-quality.sh v0.1.3 from test-quality-with-ai,
// so it runs the same on Linux, macOS and Windows with only Bun and git. Its
// output matches the bash version's rg path except where README.md lists a
// deliberate difference.
//
// Exit codes:
//   0 = no findings, or findings present but --strict not set
//   1 = HIGH-severity findings present AND --strict is set
//   2 = script error (bad args, missing tool, etc.)

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

const VERSION = "0.2.0";
const SCRIPT_NAME = "check-test-quality.ts";

const EXIT_CODE_CLEAN = 0;
const EXIT_CODE_STRICT_FAILURE = 1;
const EXIT_CODE_SCRIPT_ERROR = 2;

const ALL_CHECKS = [
  "disabled-tests",
  "ts-suppression",
  "snapshot-auto-update",
  "weak-assertions",
  "swallowed-errors",
  "coverage-regression",
] as const;

// Test file name patterns, case-sensitive.
const TEST_FILE_PATTERN =
  /.*(\.test|\.spec)\.(ts|tsx|js|jsx|mjs|cjs)$|.*_test\.go$|test_.*\.py$|.*_test\.py$|.*_spec\.rb$/;

// Dependency and build directories. node_modules is the main offender: upstream
// packages ship tests full of the patterns flagged here.
const EXCLUDED_DIRECTORY_PATTERN =
  /\/(node_modules|\.git|dist|build|coverage|\.next|\.nuxt|\.svelte-kit|out|target)\//;

const TEST_CONFIG_FILE_PATTERN =
  /(vitest|jest|bun)\.config\.(ts|js|mjs|cjs)$|bunfig\.toml$|package\.json$/;
const SNAPSHOT_FILE_PATTERN = /\.snap$|__snapshots__\//;
const CI_CONFIG_FILE_PATTERN =
  /package\.json$|\.github\/workflows\/.*\.ya?ml$|\.gitlab-ci\.yml$|\.circleci\/config\.yml$/;
const TYPESCRIPT_FILE_PATTERN = /\.tsx?$/;

type Severity = "HIGH" | "MEDIUM" | "LOW";
const SEVERITY_ORDER: Severity[] = ["HIGH", "MEDIUM", "LOW"];

/** One detected signal. A line of 0 means "the file as a whole". */
type Finding = {
  severity: Severity;
  check: string;
  file: string;
  line: number;
  description: string;
};

type Options = {
  strict: boolean;
  json: boolean;
  verbose: boolean;
  diffRange: string | undefined;
  checks: string[];
  targetDirectory: string;
};

class ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptError";
  }
}

// ─── output styling (TTY only) ──────────────────────────────────────────────

// @types/node types isTTY as boolean, but it is undefined when stdout is a pipe or
// file; read it through a type that says so. (launcher/src/cli.ts has the same
// helper; this script is installed on its own, so it cannot import that one.)
type PossiblyTerminalStream = { isTTY?: boolean };
function isTerminal(stream: PossiblyTerminalStream): boolean {
  return stream.isTTY === true;
}

const useColor = isTerminal(process.stdout) && (process.env.NO_COLOR ?? "") === "";
const style = {
  red: useColor ? "\u001b[31m" : "",
  yellow: useColor ? "\u001b[33m" : "",
  cyan: useColor ? "\u001b[36m" : "",
  dim: useColor ? "\u001b[2m" : "",
  bold: useColor ? "\u001b[1m" : "",
  reset: useColor ? "\u001b[0m" : "",
};

function usage(): string {
  return `${SCRIPT_NAME} v${VERSION}

Pattern-based pre-screen for test fig-leaf signals. Bundled with the
j5-test-quality skill.

Usage:
  bun ${SCRIPT_NAME} [options] [path]

Options:
  --diff RANGE         Only check files changed in git diff RANGE
                       (e.g. --diff origin/main..HEAD)
  --check LIST         Comma-separated checks to run. Default: all.
                       Available: disabled-tests, ts-suppression,
                                  snapshot-auto-update, weak-assertions,
                                  swallowed-errors, coverage-regression
  --strict             Exit 1 on any HIGH-severity finding
  --json               Output structured JSON instead of human-readable
  --verbose            Show files being scanned and other diagnostics
  --help               Show this help and exit
  --version            Show version and exit

Examples:
  bun ${SCRIPT_NAME}                                # scan cwd
  bun ${SCRIPT_NAME} path/to/tests                  # scan a specific dir
  bun ${SCRIPT_NAME} --diff origin/main..HEAD       # scan PR diff
  bun ${SCRIPT_NAME} --check disabled-tests --strict
  bun ${SCRIPT_NAME} --json                         # CI-friendly

Exit codes:
  0  no findings, or findings without --strict
  1  HIGH-severity findings with --strict
  2  script error
`;
}

// ─── argument parsing ───────────────────────────────────────────────────────

type ParseResult = { kind: "run"; options: Options } | { kind: "exit"; exitCode: number };

function parseOptions(commandLineArguments: string[]): ParseResult {
  const options: Options = {
    strict: false,
    json: false,
    verbose: false,
    diffRange: undefined,
    checks: [...ALL_CHECKS],
    targetDirectory: ".",
  };
  let index = 0;
  while (index < commandLineArguments.length) {
    const argument = commandLineArguments[index] ?? "";
    index += 1;
    if (argument === "--diff") {
      const range = commandLineArguments[index] ?? "";
      index += 1;
      if (range === "") {
        throw new ScriptError("--diff requires a range argument");
      }
      if (Bun.which("git") === null) {
        throw new ScriptError("--diff requires git");
      }
      options.diffRange = range;
    } else if (argument === "--check") {
      const list = commandLineArguments[index] ?? "";
      index += 1;
      if (list === "") {
        throw new ScriptError("--check requires a list argument");
      }
      options.checks = list.split(",").map((check) => check.trim());
    } else if (argument === "--strict") {
      options.strict = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--verbose") {
      options.verbose = true;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(usage());
      return { kind: "exit", exitCode: EXIT_CODE_CLEAN };
    } else if (argument === "--version") {
      console.log(VERSION);
      return { kind: "exit", exitCode: EXIT_CODE_CLEAN };
    } else if (argument.startsWith("-")) {
      process.stderr.write(`error: unknown flag ${argument}\n${usage()}`);
      return { kind: "exit", exitCode: EXIT_CODE_SCRIPT_ERROR };
    } else {
      options.targetDirectory = argument;
    }
  }
  return { kind: "run", options };
}

// ─── file collection ────────────────────────────────────────────────────────

/** Runs git and returns its output lines; a failing git yields no lines, as in the bash version. */
function gitLines(gitArguments: string[]): string[] {
  const completedProcess = Bun.spawnSync(["git", ...gitArguments], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (completedProcess.exitCode !== 0) {
    return [];
  }
  return completedProcess.stdout
    .toString()
    .split("\n")
    .filter((line) => line !== "");
}

function isInsideGitWorkTree(directory: string): boolean {
  const completedProcess = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd: directory,
    stdout: "pipe",
    stderr: "ignore",
  });
  return completedProcess.exitCode === 0 && completedProcess.stdout.toString().trim() === "true";
}

// Files under the target, relative to it, with forward slashes. Inside a git work
// tree: tracked plus untracked-but-not-ignored files, like rg's .gitignore handling.
// Outside one: every file. Hidden files are included (except .git), unlike rg, so
// .github/workflows is scanned; see README.md.
function listFilesRelativeTo(targetDirectory: string): string[] {
  if (Bun.which("git") !== null && isInsideGitWorkTree(targetDirectory)) {
    const completedProcess = Bun.spawnSync(
      ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: targetDirectory, stdout: "pipe", stderr: "ignore" },
    );
    return completedProcess.stdout
      .toString()
      .split("\0")
      .filter((path) => path !== "" && existsSync(join(targetDirectory, path)));
  }
  const relativePaths: string[] = [];
  const walk = (relativeDirectory: string): void => {
    for (const entry of readdirSync(join(targetDirectory, relativeDirectory), {
      withFileTypes: true,
    })) {
      if (entry.name === ".git") {
        continue;
      }
      const relativePath =
        relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(relativePath);
      } else if (entry.isFile()) {
        relativePaths.push(relativePath);
      }
    }
  };
  walk("");
  return relativePaths;
}

// Paths as the bash version printed them: the target as given, then the file.
function filesUnderTarget(targetDirectory: string): string[] {
  if (!existsSync(targetDirectory) || !statSync(targetDirectory).isDirectory()) {
    return existsSync(targetDirectory) ? [targetDirectory] : [];
  }
  // `rg --files .` prints `./src/a.test.ts`; `rg --files tests` prints `tests/a.test.ts`.
  const prefix = targetDirectory.replaceAll("\\", "/").replace(/\/+$/, "");
  const shownPrefix = prefix === "" ? "." : prefix;
  return listFilesRelativeTo(targetDirectory).map(
    (relativePath) => `${shownPrefix}/${relativePath}`,
  );
}

function collectTestFiles(options: Options): string[] {
  const candidates =
    options.diffRange === undefined
      ? filesUnderTarget(options.targetDirectory)
      : gitLines(["diff", "--name-only", "--diff-filter=AM", options.diffRange]);
  return candidates
    .filter((path) => TEST_FILE_PATTERN.test(path))
    .filter((path) => !EXCLUDED_DIRECTORY_PATTERN.test(path))
    .toSorted();
}

// ─── checks ─────────────────────────────────────────────────────────────────

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/);
  } catch {
    // Unreadable files (removed since listing, permissions) are skipped, as grep's
    // errors were discarded in the bash version.
    return [];
  }
}

function searchFilesForPattern(
  files: string[],
  pattern: RegExp,
  severity: Severity,
  check: string,
  description: string,
  findings: Finding[],
): void {
  for (const file of files) {
    readLines(file).forEach((lineText, lineIndex) => {
      if (pattern.test(lineText)) {
        findings.push({ severity, check, file, line: lineIndex + 1, description });
      }
    });
  }
}

function checkDisabledTests(files: string[], findings: Finding[]): void {
  searchFilesForPattern(
    files,
    /\b(test|it|describe)\.skip\(/,
    "HIGH",
    "disabled-tests",
    ".skip() on test — committed disabled test, must have tracking issue or be re-enabled",
    findings,
  );
  searchFilesForPattern(
    files,
    /\b(test|it|describe)\.todo\(/,
    "MEDIUM",
    "disabled-tests",
    ".todo() on test — unimplemented test, must have tracking issue",
    findings,
  );
  searchFilesForPattern(
    files,
    /\b(test|it|describe)\.only\(/,
    "HIGH",
    "disabled-tests",
    ".only() on test — silently skips every other test in the file, MUST be removed before merge",
    findings,
  );
}

function checkTypeScriptSuppression(files: string[], findings: Finding[]): void {
  const typeScriptFiles = files.filter((file) => TYPESCRIPT_FILE_PATTERN.test(file));
  searchFilesForPattern(
    typeScriptFiles,
    /@ts-expect-error/,
    "MEDIUM",
    "ts-suppression",
    "@ts-expect-error in test — suppresses type errors; verify the test isn't hiding a real problem",
    findings,
  );
  searchFilesForPattern(
    typeScriptFiles,
    /@ts-ignore/,
    "HIGH",
    "ts-suppression",
    "@ts-ignore in test — prefer @ts-expect-error (fails when no longer needed); investigate the underlying type issue",
    findings,
  );
}

function checkSnapshotAutoUpdate(options: Options, findings: Finding[]): void {
  const configFiles = (
    options.diffRange === undefined
      ? filesUnderTarget(options.targetDirectory)
      : gitLines(["diff", "--name-only", "--diff-filter=AM", options.diffRange])
  )
    .filter((path) => CI_CONFIG_FILE_PATTERN.test(path))
    .toSorted();
  // -u or --update-snapshots in a test invocation.
  searchFilesForPattern(
    configFiles,
    /(vitest|jest|bun test).*(--update-snapshots|--update|\s-u\s|\s-u")/,
    "HIGH",
    "snapshot-auto-update",
    "auto-snapshot-update flag detected in test command — snapshots will regenerate without inspection; remove flag",
    findings,
  );

  if (options.diffRange === undefined) {
    return;
  }
  // Snapshot files changed without a changed source file next to them.
  const changedFiles = gitLines(["diff", "--name-only", options.diffRange]);
  for (const snapshotFile of changedFiles.filter((path) => SNAPSHOT_FILE_PATTERN.test(path))) {
    const directory = posix.dirname(snapshotFile);
    const siblingSourceChanged = changedFiles.some(
      (path) =>
        path.startsWith(`${directory}/`) &&
        /\.(ts|tsx|js|jsx|mjs)$/.test(path) &&
        !/\.test\.|\.spec\./.test(path),
    );
    if (!siblingSourceChanged) {
      findings.push({
        severity: "MEDIUM",
        check: "snapshot-auto-update",
        file: snapshotFile,
        line: 0,
        description:
          "snapshot file changed but no sibling source file changed — likely regenerated without inspecting the diff",
      });
    }
  }
}

function checkWeakAssertions(files: string[], findings: Finding[]): void {
  searchFilesForPattern(
    files,
    /expect\([^)]*\)\.toBeDefined\(\)/,
    "LOW",
    "weak-assertions",
    "toBeDefined() — verifies presence, not correctness. Combine with shape/value check or remove if not load-bearing.",
    findings,
  );
  searchFilesForPattern(
    files,
    /expect\([^)]*\)\.toBeTruthy\(\)/,
    "LOW",
    "weak-assertions",
    "toBeTruthy() — passes for any non-empty value. Prefer specific equality/shape assertion.",
    findings,
  );
  searchFilesForPattern(
    files,
    /expect\([^)]*\)\.not\.toThrow\(\)/,
    "LOW",
    "weak-assertions",
    "not.toThrow() — verifies no crash, not correct output. Combine with output verification.",
    findings,
  );
}

function checkSwallowedErrors(files: string[], findings: Finding[]): void {
  // Empty catch blocks: catch (e) {}, catch (e) { }, catch {}.
  searchFilesForPattern(
    files,
    /catch\s*\([^)]*\)\s*\{\s*\}|catch\s*\{\s*\}/,
    "HIGH",
    "swallowed-errors",
    "empty catch block in test — swallows assertion errors; the test may pass when it should fail",
    findings,
  );
}

function checkCoverageRegression(options: Options, findings: Finding[]): void {
  if (options.diffRange === undefined) {
    if (options.verbose) {
      console.error("    (skipped: requires --diff)");
    }
    return;
  }
  const configFiles = gitLines([
    "diff",
    "--name-only",
    "--diff-filter=M",
    options.diffRange,
  ]).filter((path) => TEST_CONFIG_FILE_PATTERN.test(path));
  for (const configFile of configFiles) {
    const removedThresholdLines = gitLines(["diff", options.diffRange, "--", configFile]).filter(
      (line) =>
        /^-.*coverageThreshold/.test(line) ||
        /^-\s*(lines|statements|branches|functions)\s*:\s*[0-9]/.test(line),
    );
    if (removedThresholdLines.length > 0) {
      findings.push({
        severity: "MEDIUM",
        check: "coverage-regression",
        file: configFile,
        line: 0,
        description: "coverageThreshold reduced or removed in config — investigate justification",
      });
    }
  }
}

function runCheck(check: string, options: Options, testFiles: string[], findings: Finding[]): void {
  if (options.verbose) {
    console.error(`  running: ${check}`);
  }
  switch (check) {
    case "disabled-tests":
      checkDisabledTests(testFiles, findings);
      return;
    case "ts-suppression":
      checkTypeScriptSuppression(testFiles, findings);
      return;
    case "snapshot-auto-update":
      checkSnapshotAutoUpdate(options, findings);
      return;
    case "weak-assertions":
      checkWeakAssertions(testFiles, findings);
      return;
    case "swallowed-errors":
      checkSwallowedErrors(testFiles, findings);
      return;
    case "coverage-regression":
      checkCoverageRegression(options, findings);
      return;
    default:
      console.error(`warning: unknown check '${check}' — skipping`);
  }
}

// ─── output ─────────────────────────────────────────────────────────────────

function countBySeverity(findings: Finding[], severity: Severity): number {
  return findings.filter((finding) => finding.severity === severity).length;
}

function formatHuman(findings: Finding[], fileCount: number): string {
  if (findings.length === 0) {
    return `${style.bold}check-test-quality:${style.reset} ${style.cyan}no findings${style.reset} (${fileCount} test file(s) scanned)\n`;
  }
  const colorBySeverity: Record<Severity, string> = {
    HIGH: style.red,
    MEDIUM: style.yellow,
    LOW: style.dim,
  };
  const lines = [
    `${style.bold}check-test-quality:${style.reset} ${findings.length} finding(s) across ${fileCount} test file(s)`,
    "",
  ];
  for (const severity of SEVERITY_ORDER) {
    for (const finding of findings.filter((candidate) => candidate.severity === severity)) {
      const location = finding.line === 0 ? finding.file : `${finding.file}:${finding.line}`;
      lines.push(
        `  ${colorBySeverity[severity]}[${severity}]${style.reset} ${finding.check}  ${location}`,
      );
      lines.push(`    ${style.dim}${finding.description}${style.reset}`);
    }
  }
  lines.push("");
  lines.push(
    `${style.bold}summary:${style.reset} ${style.red}${countBySeverity(findings, "HIGH")} HIGH${style.reset}, ${style.yellow}${countBySeverity(findings, "MEDIUM")} MEDIUM${style.reset}, ${style.dim}${countBySeverity(findings, "LOW")} LOW${style.reset}`,
  );
  return `${lines.join("\n")}\n`;
}

// Same layout as the bash version; strings are JSON-escaped in full.
function formatJson(findings: Finding[], fileCount: number): string {
  const findingLines = findings.map(
    (finding) =>
      `    { "severity": ${JSON.stringify(finding.severity)}, "check": ${JSON.stringify(finding.check)}, "file": ${JSON.stringify(finding.file)}, "line": ${finding.line}, "description": ${JSON.stringify(finding.description)} }`,
  );
  return `{\n  "version": "${VERSION}",\n  "files_scanned": ${fileCount},\n  "findings": [\n${findingLines.join(",\n")}\n  ]\n}\n`;
}

// ─── main ───────────────────────────────────────────────────────────────────

function main(commandLineArguments: string[]): number {
  const parsed = parseOptions(commandLineArguments);
  if (parsed.kind === "exit") {
    return parsed.exitCode;
  }
  const options = parsed.options;

  if (options.verbose) {
    console.error(`check-test-quality v${VERSION}`);
    console.error(
      `tool: bun  |  strict: ${options.strict ? 1 : 0}  |  json: ${options.json ? 1 : 0}`,
    );
    console.error(`checks: ${options.checks.join(",")}`);
    if (options.diffRange !== undefined) {
      console.error(`diff range: ${options.diffRange}`);
    }
  }

  const testFiles = collectTestFiles(options);
  if (options.verbose) {
    console.error(`scanning ${testFiles.length} test file(s)...`);
  }
  // Zero matched files is loud: a CI job pointed at a renamed path would otherwise
  // report "clean" forever. Still exit 0, since a PR without test changes is legitimate.
  if (testFiles.length === 0) {
    console.error(
      options.diffRange === undefined
        ? `warning: no test files matched in target '${options.targetDirectory}' — verify the path is correct and contains files matching common test patterns (*.test.ts, *.spec.js, *_test.go, etc.).`
        : `warning: no test files matched in diff range '${options.diffRange}' — if you expected test changes, verify the range and TEST_FILE_REGEX.`,
    );
  }

  const findings: Finding[] = [];
  for (const check of options.checks) {
    runCheck(check, options, testFiles, findings);
  }

  process.stdout.write(
    options.json ? formatJson(findings, testFiles.length) : formatHuman(findings, testFiles.length),
  );
  return options.strict && countBySeverity(findings, "HIGH") > 0
    ? EXIT_CODE_STRICT_FAILURE
    : EXIT_CODE_CLEAN;
}

try {
  process.exit(main(Bun.argv.slice(2)));
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(EXIT_CODE_SCRIPT_ERROR);
}
