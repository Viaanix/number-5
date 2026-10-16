import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  classifyQueueItem,
  DEFAULT_ROUND_LIMIT,
  describeRoundLimit,
  everyItemSucceeded,
  formatQueueSummary,
  parseQueueValues,
  parseRoundLimit,
  type QueueItemReport,
  readResultLine,
} from "../src/queue.ts";
import { discoverTeams } from "../src/teams.ts";
import { fillTemplate } from "../src/template.ts";

describe("parseQueueValues", () => {
  test("keeps the given order, trims spaces and drops repeats", () => {
    expect(parseQueueValues("queue", "480, 474,480")).toEqual({ values: ["480", "474"] });
  });

  test.each([["474,,480"], ["474,abc"], ["0"], ["-3"], [""]])(
    "rejects %p instead of skipping the bad part",
    (rawValue) => {
      expect(parseQueueValues("queue", rawValue)).toEqual({
        problem: `--queue takes comma-separated positive integers, e.g. 474,480; got '${rawValue}'`,
      });
    },
  );
});

describe("parseRoundLimit and describeRoundLimit", () => {
  test("reads a number of rounds, and 'none' or an empty answer as no limit", () => {
    expect(parseRoundLimit("3")).toEqual({ limit: { kind: "limited", rounds: 3 } });
    expect(parseRoundLimit("none")).toEqual({ limit: { kind: "unlimited" } });
    expect(parseRoundLimit(" ")).toEqual({ limit: { kind: "unlimited" } });
  });

  // Catches 0 being read as "no limit" or as a limit that allows no fix at all.
  test("rejects zero and words other than none", () => {
    expect(parseRoundLimit("0")).toEqual({
      problem: "--max-rounds must be a positive integer or 'none', got '0'",
    });
    expect(parseRoundLimit("ten")).toHaveProperty("problem");
  });

  // Catches the default drifting from the documented 5 rounds, or becoming unlimited.
  test("the default limit is 5 rounds and is described as such", () => {
    expect(DEFAULT_ROUND_LIMIT).toEqual({ kind: "limited", rounds: 5 });
    expect(describeRoundLimit(DEFAULT_ROUND_LIMIT)).toBe("at most 5 fix rounds");
  });

  test("words the limit for the preamble", () => {
    expect(describeRoundLimit({ kind: "limited", rounds: 1 })).toBe("at most 1 fix round");
    expect(describeRoundLimit({ kind: "limited", rounds: 4 })).toBe("at most 4 fix rounds");
    expect(describeRoundLimit({ kind: "unlimited" })).toBe("no limit on the number of fix rounds");
  });
});

describe("readResultLine and classifyQueueItem", () => {
  test("reads the PR URL from the RESULT line", () => {
    expect(readResultLine("work…\nRESULT: PR https://github.com/o/r/pull/9\n")).toEqual({
      kind: "pull-request",
      url: "https://github.com/o/r/pull/9",
    });
  });

  // Catches a team whose work is not a pull request (triage) never being able to succeed in a
  // queue: its last line is DONE, which used to read as "no RESULT line".
  test("reads a DONE line as a finished item that opened no pull request", () => {
    expect(readResultLine("labeled it\nRESULT: DONE needs-info #12: asked 3 questions\n")).toEqual({
      kind: "done",
      detail: "needs-info #12: asked 3 questions",
    });
  });

  test("lets a DONE line win over a non-zero exit, like the other RESULT lines", () => {
    expect(classifyQueueItem(1, "RESULT: DONE ready #7: one pull request of work")).toEqual({
      kind: "done",
      detail: "ready #7: one pull request of work",
    });
  });

  // Catches the first RESULT line winning: an agent may quote the format early (as
  // the prompt does) and report its real outcome at the end.
  test("uses the last RESULT line", () => {
    const output =
      "I will end with RESULT: PR <url>\nRESULT: PR https://x/1\nmore\nRESULT: FAILED tests still red\n";
    expect(readResultLine(output)).toEqual({ kind: "failed", reason: "tests still red" });
  });

  test("ignores RESULT text that is not alone on its line", () => {
    expect(readResultLine("say RESULT: PR https://x/1 at the end")).toBeUndefined();
  });

  // Catches trusting the exit code: docker agent --exec exits 0 when the agent
  // finishes its turn, whatever it achieved.
  test("treats exit 0 without a RESULT line as a failure of the item", () => {
    expect(classifyQueueItem(0, "I fixed most of it.")).toEqual({
      kind: "failed",
      reason: "no RESULT line (exit 0): I fixed most of it.",
    });
  });

  test("lets the RESULT line win over a non-zero exit", () => {
    expect(classifyQueueItem(1, "RESULT: FAILED build broken")).toEqual({
      kind: "failed",
      reason: "build broken",
    });
  });

  // Catches a session limit marking every remaining issue failed in seconds.
  test("stops the queue when the agent itself could not run", () => {
    const output =
      "You've hit your session limit · resets 1pm (America/Chicago)harness claude-code failed: wait: exit status 1";
    expect(classifyQueueItem(1, output)).toEqual({
      kind: "stopped",
      reason: `the agent could not run: ${output}`,
    });
  });

  test("does not stop the queue for an infrastructure-looking line when the run exited 0", () => {
    expect(classifyQueueItem(0, "the log said: harness x failed earlier").kind).toBe("failed");
  });
});

describe("formatQueueSummary and everyItemSucceeded", () => {
  const pullRequestReport: QueueItemReport = {
    value: "474",
    outcome: { kind: "pull-request", url: "https://x/pull/9" },
    logPath: "/p/.j5/queue/t/issue-474.log",
  };
  const reports: QueueItemReport[] = [
    pullRequestReport,
    {
      value: "480",
      outcome: { kind: "failed", reason: "tests still red" },
      logPath: "/p/.j5/queue/t/issue-480.log",
    },
    { value: "482", outcome: { kind: "not-run" }, logPath: undefined },
  ];

  test("lists every item with its outcome and log, and says why the queue ended early", () => {
    expect(formatQueueSummary("Queue", reports, true)).toBe(
      [
        "# Queue",
        "",
        "1 of 3 opened a pull request.",
        "",
        "- #474: PR https://x/pull/9 (log: /p/.j5/queue/t/issue-474.log)",
        "- #480: FAILED: tests still red (log: /p/.j5/queue/t/issue-480.log)",
        "- #482: not run",
        "",
        'Interrupted with Ctrl-C; the items marked "not run" were not started.',
        "",
      ].join("\n"),
    );
  });

  test("succeeds only when every item opened a pull request", () => {
    expect(everyItemSucceeded(reports)).toBe(false);
    expect(everyItemSucceeded([pullRequestReport])).toBe(true);
    expect(everyItemSucceeded([])).toBe(false);
  });

  // Catches issue-team's summary changing: with no DONE items the headline is the one a queue of
  // pull requests always had.
  test("keeps the pull-request headline when no item is DONE", () => {
    expect(formatQueueSummary("Queue", [pullRequestReport], false)).toContain(
      "1 of 1 opened a pull request.",
    );
  });

  test("counts DONE items as finished in the headline, and as a success in the exit code", () => {
    const doneReport: QueueItemReport = {
      value: "12",
      outcome: { kind: "done", detail: "needs-info #12: asked 3 questions" },
      logPath: "/p/.j5/queue/t/issue-12.log",
    };

    const summary = formatQueueSummary("Queue", [pullRequestReport, doneReport], false);

    expect(summary).toContain(
      "2 of 2 finished (1 opened a pull request, 1 completed without one).",
    );
    expect(summary).toContain(
      "- #12: DONE: needs-info #12: asked 3 questions (log: /p/.j5/queue/t/issue-12.log)",
    );
    expect(everyItemSucceeded([doneReport])).toBe(true);
    const failedReport: QueueItemReport = {
      value: "13",
      outcome: { kind: "failed", reason: "no RESULT line" },
      logPath: undefined,
    };
    expect(everyItemSucceeded([doneReport, failedReport])).toBe(false);
  });
});

// Every queue preamble quotes the RESULT lines it asks for. If docker-agent prints the
// message back in an --exec run, those examples must not read as the item's outcome:
// they stay indented, so they never start a line. Catches a reflow to column 0.
describe("queue preambles in the real manifests", () => {
  const teams = discoverTeams(join(import.meta.dir, "..", ".."));
  const queuedEntryPoints = teams.flatMap((team) =>
    Object.entries(team.entrypoints).flatMap(([entryPointName, entryPoint]) =>
      entryPoint.queue === undefined
        ? []
        : [{ name: `${team.name} ${entryPointName}`, entryPoint }],
    ),
  );

  test("at least one entry point has a queue", () => {
    expect(queuedEntryPoints.length).toBeGreaterThan(0);
  });

  test.each(queuedEntryPoints)(
    "$name: the filled preamble and message hold no RESULT line",
    ({ entryPoint }) => {
      const values: Record<string, string> = {
        repo: "app",
        position: "1",
        count: "2",
        round_limit: "at most 3 fix rounds",
      };
      for (const parameterName of Object.keys(entryPoint.parameters)) {
        values[parameterName] = "7";
      }
      const preamble = fillTemplate(entryPoint.queue?.preamble ?? "", values);
      const message = fillTemplate(entryPoint.message, values);
      expect(preamble).toMatch(/RESULT: (?:PR|DONE) /);
      expect(preamble).toContain("RESULT: FAILED");
      expect(readResultLine(`${preamble}\n\n${message}`)).toBeUndefined();
    },
  );
});
