// Stands in for `docker` in the queue test. It reads the issue number from the
// worktree it was started in (`<repo>-issue-<n>`, from --working-dir), prints what it
// received as one JSON line, then plays one outcome per issue:
//   1 → a PR; 2 → FAILED; 3 → no RESULT line, exit 1;
//   5 → the agent could not run (a Claude session limit), which stops the queue.
import { basename } from "node:path";

import { answerDebugConfigCall } from "./fake-debug-config.ts";

const WORKTREE_NUMBER_PATTERN = /-issue-(\d+)$/;
const FAILURE_EXIT_CODE = 1;

const commandArguments = process.argv.slice(2);
answerDebugConfigCall(commandArguments);
const workingDirectoryIndex = commandArguments.indexOf("--working-dir");
const worktreePath = commandArguments[workingDirectoryIndex + 1] ?? "";
const issueNumber = WORKTREE_NUMBER_PATTERN.exec(basename(worktreePath))?.[1] ?? "unknown";

console.log(
  JSON.stringify({
    issue: issueNumber,
    workingDirectory: process.cwd(),
    unattended: commandArguments.includes("--exec"),
    message: commandArguments.at(-1),
  }),
);

if (issueNumber === "1") {
  console.log("Opened it.\nRESULT: PR https://example.invalid/pull/101");
} else if (issueNumber === "2") {
  console.log("RESULT: FAILED the date parser test is still red after 2 rounds");
} else if (issueNumber === "3") {
  console.log("partial work, then the agent stopped");
  process.exit(FAILURE_EXIT_CODE);
} else if (issueNumber === "5") {
  console.error(
    "You've hit your session limit · resets 1pm (America/Chicago)harness claude-code failed: wait: exit status 1",
  );
  process.exit(FAILURE_EXIT_CODE);
}
