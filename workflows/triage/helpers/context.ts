// triage_context: reads one issue and the checkout it concerns, and prints them for the triager.
// Read-only: it writes nothing to GitHub and nothing to the repository.

import { readToolArgument, runAndCapture, runHelper } from "#launcher/team-helper.ts";

import { renderIssueContext } from "./context-text.ts";
import { readIssue, readRepository } from "./github.ts";
import { parseIssueNumber } from "./triage-plan.ts";

runHelper("triage-context", () => {
  const issueNumber = parseIssueNumber(readToolArgument("issue"));
  const repository = readRepository();
  const issue = readIssue(repository, issueNumber);
  const checkout = {
    head: runAndCapture(["git", "rev-parse", "HEAD"]).trim(),
    branch: runAndCapture(["git", "rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    hasUncommittedChanges: runAndCapture(["git", "status", "--porcelain"]).trim() !== "",
  };
  console.log(renderIssueContext(repository, issue, checkout));
});
