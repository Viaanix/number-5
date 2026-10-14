// Renders a launch plan as one command line in the user's shell, so `j5 --print`
// output can be read, pasted into a terminal, and compared exactly in tests.
// POSIX shells (bash, zsh) on Linux and macOS; PowerShell on Windows.

import type { LaunchPlan } from "./plan.ts";

/** The shell syntax a command line is written in. */
export type ShellDialect = "posix" | "powershell";

// Words made only of these characters mean the same thing quoted or unquoted in bash/zsh.
const POSIX_SAFE_WORD_PATTERN = /^[A-Za-z0-9_/.=:,@+%-]+$/;

// PowerShell gives meaning to more characters in bare arguments than bash does:
// `,` builds an array, a leading `@` splats, `%` and `$` are special. Keep bare words
// to a set PowerShell passes through unchanged, including Windows path backslashes.
const POWERSHELL_SAFE_WORD_PATTERN = /^[A-Za-z0-9_/\\.=:+-]+$/;

/** Returns the dialect `--print` uses on the given platform (process.platform). */
export function shellDialectForPlatform(platform: NodeJS.Platform): ShellDialect {
  return platform === "win32" ? "powershell" : "posix";
}

/** Quotes one word for bash/zsh; safe words are returned unchanged. */
export function quoteForPosixShell(word: string): string {
  if (POSIX_SAFE_WORD_PATTERN.test(word)) {
    return word;
  }
  // Inside single quotes nothing is special except the closing quote itself,
  // which is written as: end quote, escaped quote, reopen quote.
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/** Quotes one word for PowerShell; safe words are returned unchanged. */
export function quoteForPowerShell(word: string): string {
  if (POWERSHELL_SAFE_WORD_PATTERN.test(word)) {
    return word;
  }
  // In a PowerShell single-quoted string nothing is expanded; a literal ' is written ''.
  return `'${word.replaceAll("'", "''")}'`;
}

/**
 * Renders the plan as one command line, the worktree steps first when there are any:
 * - posix:      `git ... && git ... && cd <dir> && PATH=<dirs>:"$PATH" docker agent run ...`
 * - powershell: `& git ... && & git ... && & { Set-Location -LiteralPath <dir>; $env:Path = '<dirs>;' + $env:Path; & docker agent run ... }`
 *   (without steps, just the part inside the braces; with steps it needs PowerShell 7+ for `&&`)
 * The team's helper directories are shown without the inherited PATH, which would
 * only add noise and machine-specific paths.
 */
export function renderPlanAsShellCommand(
  plan: LaunchPlan,
  teamPathDirectories: string[],
  dialect: ShellDialect,
): string {
  if (dialect === "powershell") {
    // `&` invokes the command name as a command even when it is quoted.
    const commandText = `& ${plan.commandWords.map(quoteForPowerShell).join(" ")}`;
    const changeDirectory = `Set-Location -LiteralPath ${quoteForPowerShell(plan.workingDirectory)}`;
    let launchText = `${changeDirectory}; ${commandText}`;
    if (teamPathDirectories.length > 0) {
      const prependedPath = quoteForPowerShell(`${teamPathDirectories.join(";")};`);
      launchText = `${changeDirectory}; $env:Path = ${prependedPath} + $env:Path; ${commandText}`;
    }
    if (plan.preparationSteps.length === 0) {
      return launchText;
    }
    // `&&` (PowerShell 7+) stops at the first failed git step. The launch is a script
    // block so the chain covers it whole: after `;`, PowerShell would run docker even
    // when a step failed.
    const stepTexts = plan.preparationSteps.map(
      (stepWords) => `& ${stepWords.map(quoteForPowerShell).join(" ")}`,
    );
    return `${stepTexts.join(" && ")} && & { ${launchText} }`;
  }

  const commandText = plan.commandWords.map(quoteForPosixShell).join(" ");
  const changeDirectory = `cd ${quoteForPosixShell(plan.workingDirectory)}`;
  let launchText = `${changeDirectory} && ${commandText}`;
  if (teamPathDirectories.length > 0) {
    const prependedPath = teamPathDirectories.map(quoteForPosixShell).join(":");
    launchText = `${changeDirectory} && PATH=${prependedPath}:"$PATH" ${commandText}`;
  }
  const stepTexts = plan.preparationSteps.map((stepWords) =>
    stepWords.map(quoteForPosixShell).join(" "),
  );
  return [...stepTexts, launchText].join(" && ");
}
