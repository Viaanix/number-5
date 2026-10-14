// Renders a launch plan as one bash command line, so `daw --print` output can be
// read, pasted into a terminal, and compared exactly in tests.

import type { LaunchPlan } from "./plan.ts";

// Words made only of these characters mean the same thing quoted or unquoted in bash.
const SHELL_SAFE_WORD_PATTERN = /^[A-Za-z0-9_/.=:,@+%-]+$/;

/** Quotes one word for bash; safe words are returned unchanged. */
export function quoteForShell(word: string): string {
  if (SHELL_SAFE_WORD_PATTERN.test(word)) {
    return word;
  }
  // Inside single quotes nothing is special except the closing quote itself,
  // which is written as: end quote, escaped quote, reopen quote.
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * Renders the plan as `cd <dir> && PATH=<dirs>:"$PATH" docker agent run ...`.
 * The team's helper directories are shown without the inherited PATH, which would
 * only add noise and machine-specific paths.
 */
export function renderPlanAsShellCommand(plan: LaunchPlan, teamPathDirectories: string[]): string {
  const commandText = plan.commandWords.map(quoteForShell).join(" ");
  const changeDirectory = `cd ${quoteForShell(plan.workingDirectory)}`;
  if (teamPathDirectories.length === 0) {
    return `${changeDirectory} && ${commandText}`;
  }
  const prependedPath = teamPathDirectories.map(quoteForShell).join(":");
  return `${changeDirectory} && PATH=${prependedPath}:"$PATH" ${commandText}`;
}
