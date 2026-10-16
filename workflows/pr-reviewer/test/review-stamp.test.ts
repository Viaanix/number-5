import { describe, expect, test } from "bun:test";

import { selectUnreviewedPullRequests } from "#launcher/review-status.ts";

import { requirePostableReport, stripLocalStatusLines } from "../helpers/report.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const REVIEWER = "j5-reviewer";

// The report as the reviewer returns it, with the local-only line it adds after publishing.
const RETURNED_REPORT = [
  "VERDICT: Ship it",
  "PR: https://github.com/example/app/pull/9 (#9)",
  `Reviewed head SHA: ${HEAD}`,
  "",
  "### Findings",
  "None",
  "",
  "Comment posted: https://github.com/example/app/pull/9#issuecomment-1",
].join("\n");

describe("the review stamp", () => {
  // Catches the two sides drifting apart: if pr_comment ever posted a stamp the queue does not
  // recognize, every review would be repeated on each run and a repository would be re-reviewed
  // (and re-commented) until someone noticed.
  test("what pr_comment posts for a report is what keeps its pull request out of the queue", () => {
    const postedBody = stripLocalStatusLines(RETURNED_REPORT);
    expect(requirePostableReport(postedBody)).toBe(HEAD);

    const listing = {
      number: 9,
      isDraft: false,
      isCrossRepository: false,
      headRefOid: HEAD,
      comments: [{ author: { login: REVIEWER }, body: postedBody }],
    };
    expect(selectUnreviewedPullRequests([listing], REVIEWER).reviewable).toEqual([]);
    expect(
      selectUnreviewedPullRequests([{ ...listing, headRefOid: "f".repeat(40) }], REVIEWER)
        .reviewable,
    ).toEqual([9]);
  });
});
