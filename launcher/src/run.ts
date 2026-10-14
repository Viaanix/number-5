// Executes launch plans built by plan.ts: the git steps that create a worktree, then
// docker-agent. A single run hands the terminal to docker-agent's TUI. A queue run
// executes one plan per item, unattended (`--exec`), shows and saves each item's
// output, reads each outcome, and writes a summary.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withPathValue } from "./environment.ts";
import type { LaunchPlan } from "./plan.ts";
import {
  classifyQueueItem,
  everyItemSucceeded,
  formatQueueSummary,
  type QueueItemReport,
} from "./queue.ts";

const SUCCESS_EXIT_CODE = 0;
const FAILURE_EXIT_CODE = 1;
const SUMMARY_FILE_NAME = "summary.md";

/** One item of a queue run: the queue parameter's value and the plan that works it. */
export type QueueRunItem = { value: string; plan: LaunchPlan };

/**
 * Resolves the plan's command against the PATH the child will get, including Windows
 * PATHEXT lookup (docker → docker.exe), so a missing docker is reported by name
 * instead of as a spawn error.
 * @throws Error naming the missing command.
 */
export function resolveExecutable(plan: LaunchPlan): string {
  const [commandName] = plan.commandWords;
  if (commandName === undefined) {
    throw new Error("the launch plan has no command");
  }
  const executablePath = Bun.which(commandName, { PATH: plan.pathEnvironment });
  if (executablePath === null) {
    throw new Error(
      `'${commandName}' was not found on PATH; is Docker with the docker agent plugin installed?`,
    );
  }
  return executablePath;
}

/**
 * Runs the plan's worktree steps in order, with git's own output visible, and stops
 * at the first failure so docker-agent never starts in a directory that was not created.
 * @throws Error naming the failed step.
 */
export function runPreparationSteps(plan: LaunchPlan): void {
  for (const stepWords of plan.preparationSteps) {
    const completedStep = Bun.spawnSync(stepWords, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if (completedStep.exitCode !== SUCCESS_EXIT_CODE) {
      throw new Error(
        `${stepWords.join(" ")} failed (exit ${completedStep.exitCode}); docker-agent was not started`,
      );
    }
  }
}

function spawnPlan(
  plan: LaunchPlan,
  executablePath: string,
  standardStreams: "inherit" | "pipe",
): Bun.Subprocess<"ignore" | "inherit", "inherit" | "pipe", "inherit" | "pipe"> {
  try {
    return Bun.spawn([executablePath, ...plan.commandWords.slice(1)], {
      cwd: plan.workingDirectory,
      env: withPathValue(process.env, plan.pathEnvironment),
      // An unattended run must not read the terminal.
      stdin: standardStreams === "pipe" ? "ignore" : "inherit",
      stdout: standardStreams,
      stderr: standardStreams,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`could not start '${plan.commandWords[0]}': ${reason}`, { cause: error });
  }
}

/** Runs one plan with docker-agent's TUI in this terminal; resolves to its exit code. */
export async function runPlan(plan: LaunchPlan): Promise<number> {
  const executablePath = resolveExecutable(plan);
  // Worktree steps run after the docker check, so a missing docker leaves no worktree behind.
  runPreparationSteps(plan);
  const childProcess = spawnPlan(plan, executablePath, "inherit");
  // Ctrl-C belongs to the docker-agent TUI (it cancels the current turn). The terminal
  // sends SIGINT to the whole foreground process group, so the launcher must ignore it
  // or it would exit and leave the agent running without its parent.
  process.on("SIGINT", () => {});
  return childProcess.exited;
}

// Copies a child's output stream to this process's stream and returns all of it.
async function copyAndCollect(
  source: ReadableStream<Uint8Array>,
  destination: NodeJS.WriteStream,
): Promise<string> {
  const decoder = new TextDecoder();
  let collected = "";
  for await (const chunk of source) {
    destination.write(chunk);
    collected += decoder.decode(chunk, { stream: true });
  }
  return collected + decoder.decode();
}

// Runs one queue item with its output shown live and saved to the log file.
async function runQueueItem(
  plan: LaunchPlan,
  executablePath: string,
  logPath: string,
): Promise<{ exitCode: number; output: string }> {
  const childProcess = spawnPlan(plan, executablePath, "pipe");
  if (
    !(childProcess.stdout instanceof ReadableStream) ||
    !(childProcess.stderr instanceof ReadableStream)
  ) {
    throw new Error("the queue item's output streams were not piped");
  }
  const [standardOutput, standardError, exitCode] = await Promise.all([
    copyAndCollect(childProcess.stdout, process.stdout),
    copyAndCollect(childProcess.stderr, process.stderr),
    childProcess.exited,
  ]);
  const output = `${standardOutput}${standardError}`;
  writeFileSync(logPath, output);
  return { exitCode, output };
}

/**
 * Runs the queue's items one after another, unattended. An item that fails is reported
 * and the queue goes on; an item whose agent could not run at all stops the queue, as
 * does Ctrl-C (after the current item). Writes each item's log and summary.md into
 * logDirectory, prints the summary, and resolves to 0 only when every item opened a PR.
 */
export async function runQueue(
  items: QueueRunItem[],
  logDirectory: string,
  queueParameterName: string,
  title: string,
): Promise<number> {
  const [firstItem] = items;
  if (firstItem === undefined) {
    throw new Error("the queue is empty");
  }
  const executablePath = resolveExecutable(firstItem.plan);
  mkdirSync(logDirectory, { recursive: true });

  // One handler for the whole queue. Ctrl-C reaches the running docker-agent too (same
  // process group), which ends the current item; the flag keeps the next one from starting.
  let interruptedByUser = false;
  process.on("SIGINT", () => {
    interruptedByUser = true;
  });

  const reports: QueueItemReport[] = items.map((item) => ({
    value: item.value,
    outcome: { kind: "not-run" },
    logPath: undefined,
  }));
  for (const [index, item] of items.entries()) {
    if (interruptedByUser) {
      break;
    }
    console.error(
      `j5: queue item ${index + 1} of ${items.length}: ${queueParameterName} ${item.value}`,
    );
    const logPath = join(logDirectory, `${queueParameterName}-${item.value}.log`);
    let report: QueueItemReport;
    try {
      runPreparationSteps(item.plan);
      const { exitCode, output } = await runQueueItem(item.plan, executablePath, logPath);
      report = { value: item.value, outcome: classifyQueueItem(exitCode, output), logPath };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      writeFileSync(logPath, `${reason}\n`);
      report = { value: item.value, outcome: { kind: "failed", reason }, logPath };
    }
    reports[index] = report;
    if (report.outcome.kind === "stopped") {
      break;
    }
  }

  const summary = formatQueueSummary(title, reports, interruptedByUser);
  writeFileSync(join(logDirectory, SUMMARY_FILE_NAME), summary);
  console.log(`\n${summary}\nLogs and this summary: ${logDirectory}`);
  return everyItemSucceeded(reports) ? SUCCESS_EXIT_CODE : FAILURE_EXIT_CODE;
}
