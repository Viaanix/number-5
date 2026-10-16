// A queue run: one entry point, run unattended once per value of its queue parameter
// (e.g. once per issue number), one after another. This module is the pure part:
// parsing the queue and the round limit, reading each run's outcome from its output,
// and the summary. cli.ts does the looping, the output capture and Ctrl-C.
//
// The outcome comes from the agent's last `RESULT:` line, never from the exit code:
// `docker agent run --exec` exits 0 whenever the agent finishes its turn, whether or
// not the work succeeded.

// Issue and PR numbers: digits only, no sign, no leading zero.
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const QUEUE_SEPARATOR = ",";
const NO_ROUND_LIMIT_WORD = "none";

// `RESULT: PR <url>`, `RESULT: DONE <what was done>` or `RESULT: FAILED <reason>`, alone on a line,
// as the queue preamble in workflow.yaml asks the agent to end with. DONE is for a team whose
// work is not a pull request (the triage team labels or splits an issue).
const RESULT_LINE_PATTERN = /^RESULT: (?:PR (\S+)|DONE (.+)|FAILED (.+))$/gm;

// What docker-agent prints when the agent process itself could not run (e.g. the
// Claude session limit: "… harness claude-code failed: wait: exit status 1"), or a
// native agent's model call failed. Every later item would fail the same way.
const AGENT_INFRASTRUCTURE_FAILURE_PATTERN = /harness \S+ failed|model failed:/;

// How much of the end of a run's output a failure reason quotes.
const OUTPUT_TAIL_CHARACTER_COUNT = 300;

/** The fix-round limit for each item: a number of rounds, or none. */
export type RoundLimit = { kind: "limited"; rounds: number } | { kind: "unlimited" };

/** Fix rounds per item when a queue run gives no --max-rounds. */
export const DEFAULT_ROUND_LIMIT: RoundLimit = { kind: "limited", rounds: 5 };

/** How one queue item ended. */
export type QueueItemOutcome =
  | { kind: "pull-request"; url: string }
  /** The work finished and is not a pull request. */
  | { kind: "done"; detail: string }
  | { kind: "failed"; reason: string }
  /** The agent could not run at all; the queue stops here. */
  | { kind: "stopped"; reason: string };

/** One item of a finished (or stopped) queue, for the summary. */
export type QueueItemReport = {
  value: string;
  outcome: QueueItemOutcome | { kind: "not-run" };
  logPath: string | undefined;
};

/**
 * Parses `--queue 474,480,482`: positive integers, duplicates dropped, order kept.
 * @returns the values, or a message saying what is wrong.
 */
export function parseQueueValues(
  optionName: string,
  rawValue: string,
): { values: string[] } | { problem: string } {
  const values: string[] = [];
  for (const part of rawValue.split(QUEUE_SEPARATOR)) {
    const value = part.trim();
    if (!POSITIVE_INTEGER_PATTERN.test(value)) {
      return {
        problem: `--${optionName} takes comma-separated positive integers, e.g. 474,480; got '${rawValue}'`,
      };
    }
    if (!values.includes(value)) {
      values.push(value);
    }
  }
  return { values };
}

/**
 * Parses `--max-rounds`: a positive integer, or `none` (also an empty answer at the
 * prompt) for no limit.
 * @returns the limit, or a message saying what is wrong.
 */
export function parseRoundLimit(rawValue: string): { limit: RoundLimit } | { problem: string } {
  const value = rawValue.trim();
  if (value === "" || value === NO_ROUND_LIMIT_WORD) {
    return { limit: { kind: "unlimited" } };
  }
  if (!POSITIVE_INTEGER_PATTERN.test(value)) {
    return {
      problem: `--max-rounds must be a positive integer or '${NO_ROUND_LIMIT_WORD}', got '${rawValue}'`,
    };
  }
  return { limit: { kind: "limited", rounds: Number(value) } };
}

/** The limit as the words the preamble's {round_limit} placeholder is filled with. */
export function describeRoundLimit(limit: RoundLimit): string {
  if (limit.kind === "unlimited") {
    return "no limit on the number of fix rounds";
  }
  return limit.rounds === 1 ? "at most 1 fix round" : `at most ${limit.rounds} fix rounds`;
}

/** Reads the last RESULT line of an agent's output; undefined when there is none. */
export function readResultLine(output: string): QueueItemOutcome | undefined {
  let lastOutcome: QueueItemOutcome | undefined;
  for (const match of output.matchAll(RESULT_LINE_PATTERN)) {
    const pullRequestUrl = match[1];
    const doneDetail = match[2];
    const failureReason = match[3];
    if (pullRequestUrl !== undefined) {
      lastOutcome = { kind: "pull-request", url: pullRequestUrl };
    } else if (doneDetail !== undefined) {
      lastOutcome = { kind: "done", detail: doneDetail.trim() };
    } else if (failureReason !== undefined) {
      lastOutcome = { kind: "failed", reason: failureReason.trim() };
    }
  }
  return lastOutcome;
}

function tailOf(output: string): string {
  const trimmed = output.trim();
  const tail =
    trimmed.length > OUTPUT_TAIL_CHARACTER_COUNT
      ? `…${trimmed.slice(-OUTPUT_TAIL_CHARACTER_COUNT)}`
      : trimmed;
  return tail.replaceAll(/\s+/g, " ");
}

/**
 * Decides how a queue item ended from its exit code and everything it printed.
 * The RESULT line wins; without one, an agent that could not run stops the queue,
 * and anything else is a failure of this item only.
 */
export function classifyQueueItem(exitCode: number, output: string): QueueItemOutcome {
  const resultOutcome = readResultLine(output);
  if (resultOutcome !== undefined) {
    return resultOutcome;
  }
  if (exitCode !== 0 && AGENT_INFRASTRUCTURE_FAILURE_PATTERN.test(output)) {
    return { kind: "stopped", reason: `the agent could not run: ${tailOf(output)}` };
  }
  return {
    kind: "failed",
    reason: `no RESULT line (exit ${exitCode})${output.trim() === "" ? "" : `: ${tailOf(output)}`}`,
  };
}

/** True only when every item opened a pull request or finished; the queue's exit code is 0 then. */
export function everyItemSucceeded(reports: QueueItemReport[]): boolean {
  return (
    reports.length > 0 &&
    reports.every(
      (report) => report.outcome.kind === "pull-request" || report.outcome.kind === "done",
    )
  );
}

function describeOutcome(report: QueueItemReport): string {
  const outcome = report.outcome;
  if (outcome.kind === "pull-request") {
    return `PR ${outcome.url}`;
  }
  if (outcome.kind === "done") {
    return `DONE: ${outcome.detail}`;
  }
  if (outcome.kind === "failed") {
    return `FAILED: ${outcome.reason}`;
  }
  if (outcome.kind === "stopped") {
    return `STOPPED THE QUEUE: ${outcome.reason}`;
  }
  return "not run";
}

/**
 * Formats the queue's summary as Markdown: one line per item, then why the queue
 * ended early when it did.
 */
export function formatQueueSummary(
  title: string,
  reports: QueueItemReport[],
  interruptedByUser: boolean,
): string {
  const pullRequestCount = reports.filter(
    (report) => report.outcome.kind === "pull-request",
  ).length;
  const doneCount = reports.filter((report) => report.outcome.kind === "done").length;
  // A queue of pull requests keeps its original headline; a queue with finished-but-not-PR items
  // counts both kinds.
  const headline =
    doneCount === 0
      ? `${pullRequestCount} of ${reports.length} opened a pull request.`
      : `${pullRequestCount + doneCount} of ${reports.length} finished (${pullRequestCount} opened a pull request, ${doneCount} completed without one).`;
  const lines = [
    `# ${title}`,
    "",
    headline,
    "",
    ...reports.map(
      (report) =>
        `- #${report.value}: ${describeOutcome(report)}${report.logPath === undefined ? "" : ` (log: ${report.logPath})`}`,
    ),
  ];
  if (interruptedByUser) {
    lines.push("", 'Interrupted with Ctrl-C; the items marked "not run" were not started.');
  }
  if (reports.some((report) => report.outcome.kind === "stopped")) {
    lines.push(
      "",
      "Stopped early: the agent could not run, so every later item would have failed the same way.",
    );
  }
  return `${lines.join("\n")}\n`;
}
