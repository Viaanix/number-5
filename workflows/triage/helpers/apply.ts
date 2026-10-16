// triage_apply: records a triage verdict on one issue. This is the triager's only GitHub write, and
// everything it may do is decided here, in code: one of four j5/ labels, one comment, and (for a
// split) between two and eight child issues linked as sub-issues. It cannot edit code, close or
// reopen an issue, assign anyone, or touch any other label.
//
// J5_TRIAGE_DRY_RUN=1 makes it validate everything and print what it would do without writing.

import { runHelper } from "#launcher/team-helper.ts";

import {
  createIssue,
  createLabel,
  editLabels,
  linkSubIssue,
  listLabelNames,
  postComment,
  readIssue,
  readIssueRestId,
  readRepository,
} from "./github.ts";
import {
  buildChildBody,
  buildTriageComment,
  decideRepeat,
  labelsForChild,
  parseChildren,
  parseIssueNumber,
  parseVerdict,
  planLabelChange,
  requireCommentText,
  VERDICT_LABELS,
} from "./triage-plan.ts";

const DRY_RUN_VARIABLE = "J5_TRIAGE_DRY_RUN";

runHelper("triage-apply", () => {
  const issueNumber = parseIssueNumber(process.env.issue);
  const verdict = parseVerdict(process.env.verdict);
  const comment = requireCommentText(process.env.comment);
  const children = parseChildren(process.env.children, verdict);
  const isDryRun = process.env[DRY_RUN_VARIABLE] === "1";

  const repository = readRepository();
  if (repository.isArchived) {
    throw new Error(`${repository.nameWithOwner} is archived; nothing was written.`);
  }
  const issue = readIssue(repository, issueNumber);
  if (issue.state !== "OPEN") {
    throw new Error(
      `issue #${issueNumber} is ${issue.state}; only open issues are triaged. Nothing was written.`,
    );
  }

  const decision = decideRepeat(
    {
      labelNames: issue.labels.map((label) => label.name),
      commentBodies: issue.comments.map((existingComment) => existingComment.body),
      subIssueCount: issue.subIssues.totalCount,
    },
    verdict,
  );
  if (decision.kind === "refuse") {
    throw new Error(`issue #${issueNumber}: ${decision.reason}`);
  }
  if (decision.kind === "skip") {
    console.log(`Skipped issue #${issueNumber}: ${decision.reason}. Nothing was written.`);
    return;
  }

  const currentLabelNames = issue.labels.map((label) => label.name);
  const labelChange = planLabelChange(currentLabelNames, verdict);
  const verdictLabel = VERDICT_LABELS[verdict];

  if (isDryRun) {
    console.log(
      [
        `DRY RUN (${DRY_RUN_VARIABLE}=1): nothing was written to ${repository.nameWithOwner}.`,
        `Would label issue #${issueNumber}: add ${labelChange.add.join(", ") || "nothing"}; remove ${labelChange.remove.join(", ") || "nothing"}.`,
        `Would post one comment (${comment.length} characters).`,
        ...children.map(
          (child, index) =>
            `Would create sub-issue ${index + 1}: ${child.title} [${labelsForChild(currentLabelNames).join(", ")}]`,
        ),
      ].join("\n"),
    );
    return;
  }

  // Labels first, then the comment: a failure after the labels leaves an issue a re-run will
  // finish (the last comment is not a triage comment yet), while the other order would repeat it.
  const existingLabelNames = new Set(listLabelNames());
  for (const label of [verdictLabel, ...(verdict === "split" ? [VERDICT_LABELS.ready] : [])]) {
    if (!existingLabelNames.has(label.name)) {
      createLabel(label);
      existingLabelNames.add(label.name);
    }
  }

  const createdChildren: Array<{ number: number; title: string; url: string }> = [];
  try {
    for (const child of children) {
      const created = createIssue(
        child.title,
        buildChildBody(issueNumber, child.body),
        labelsForChild(currentLabelNames),
      );
      createdChildren.push({ number: created.number, title: child.title, url: created.url });
      linkSubIssue(repository, issueNumber, readIssueRestId(repository, created.number));
    }
    editLabels(issueNumber, labelChange.add, labelChange.remove);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const createdList =
      createdChildren.length === 0
        ? "No sub-issue had been created."
        : `Already created: ${createdChildren.map((child) => `#${child.number} (${child.url})`).join(", ")}; they may need linking to #${issueNumber} by hand.`;
    throw new Error(
      `${reason}. The verdict was not finished on issue #${issueNumber}. ${createdList} Do not call triage_apply again for this issue; report this as FAILED.`,
      { cause: error },
    );
  }

  const commentUrl = postComment(
    issueNumber,
    buildTriageComment(verdict, comment, createdChildren),
  );
  console.log(
    [
      `Triaged issue #${issueNumber} as ${verdictLabel.name}.`,
      `Comment: ${commentUrl}`,
      ...createdChildren.map((child) => `Sub-issue #${child.number}: ${child.url}`),
    ].join("\n"),
  );
});
