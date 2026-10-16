import { describe, expect, test } from "bun:test";

import {
  reviewedHeadOfComment,
  selectUnreviewedPullRequests,
  type PullRequestListing,
} from "../src/review-status.ts";

const REVIEWER = "j5-reviewer";
const HEAD = "0123456789abcdef0123456789abcdef01234567";

function pullRequestWithComment(
  login: string | null,
  body: string,
  headRefOid = HEAD,
): PullRequestListing {
  return {
    number: 1,
    isDraft: false,
    headRefOid,
    comments: [{ author: login === null ? null : { login }, body }],
  };
}

describe("selectUnreviewedPullRequests", () => {
  // Catches a comment from a deleted account (gh prints a null author) crashing the whole queue
  // listing, or counting as a review.
  test("a comment with no author is not a review and does not break the listing", () => {
    const listing = pullRequestWithComment(null, `Reviewed head SHA: ${HEAD}`);
    expect(selectUnreviewedPullRequests([listing], REVIEWER)).toEqual([1]);
  });

  // Catches a quote or a sentence about a review passing for one: only the stamp line the
  // reviewer posts, alone on its line, marks a pull request reviewed.
  test.each([
    ["a quoted stamp", `> Reviewed head SHA: ${HEAD}`],
    ["a stamp inside a sentence", `The bot wrote Reviewed head SHA: ${HEAD} earlier.`],
    ["a stamp with trailing text", `Reviewed head SHA: ${HEAD} (stale)`],
  ])("%s is not a review", (_description, body) => {
    expect(
      selectUnreviewedPullRequests([pullRequestWithComment(REVIEWER, body)], REVIEWER),
    ).toEqual([1]);
  });

  // Catches a review comment edited or posted with Windows line endings being re-reviewed on every
  // run.
  test("a stamp line ending in a carriage return still counts", () => {
    const body = `VERDICT: Ship it\r\nReviewed head SHA: ${HEAD}\r\n\r\nNothing found.\r\n`;
    expect(
      selectUnreviewedPullRequests([pullRequestWithComment(REVIEWER, body)], REVIEWER),
    ).toEqual([]);
  });

  // Catches the head comparison being skipped: a review of an earlier commit must not hold back
  // the pull request once new commits are pushed.
  test("a review of an older head does not count", () => {
    const body = `VERDICT: Ship it\nReviewed head SHA: ${"f".repeat(40)}\n`;
    expect(
      selectUnreviewedPullRequests([pullRequestWithComment(REVIEWER, body)], REVIEWER),
    ).toEqual([1]);
  });
});

describe("reviewedHeadOfComment", () => {
  test("reads the commit from the stamp line and nothing from a comment without one", () => {
    expect(reviewedHeadOfComment(`VERDICT: Ship it\nReviewed head SHA: ${HEAD}\n`)).toBe(HEAD);
    expect(reviewedHeadOfComment("Looks fine to me.")).toBeUndefined();
  });
});
