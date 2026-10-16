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
    isCrossRepository: false,
    headRefOid,
    comments: [{ author: login === null ? null : { login }, body }],
  };
}

function reviewable(pullRequests: PullRequestListing[]): number[] {
  return selectUnreviewedPullRequests(pullRequests, REVIEWER).reviewable;
}

describe("selectUnreviewedPullRequests", () => {
  // Catches a comment from a deleted account (gh prints a null author) crashing the whole queue
  // listing, or counting as a review.
  test("a comment with no author is not a review and does not break the listing", () => {
    const listing = pullRequestWithComment(null, `Reviewed head SHA: ${HEAD}`);
    expect(reviewable([listing])).toEqual([1]);
  });

  // Catches a quote or a sentence about a review passing for one: only the stamp line the
  // reviewer posts, alone on its line, marks a pull request reviewed.
  test.each([
    ["a quoted stamp", `> Reviewed head SHA: ${HEAD}`],
    ["a stamp inside a sentence", `The bot wrote Reviewed head SHA: ${HEAD} earlier.`],
    ["a stamp with trailing text", `Reviewed head SHA: ${HEAD} (stale)`],
  ])("%s is not a review", (_description, body) => {
    expect(reviewable([pullRequestWithComment(REVIEWER, body)])).toEqual([1]);
  });

  // Catches a review comment edited or posted with Windows line endings being re-reviewed on every
  // run.
  test("a stamp line ending in a carriage return still counts", () => {
    const body = `VERDICT: Ship it\r\nReviewed head SHA: ${HEAD}\r\n\r\nNothing found.\r\n`;
    expect(reviewable([pullRequestWithComment(REVIEWER, body)])).toEqual([]);
  });

  // Catches the head comparison being skipped: a review of an earlier commit must not hold back
  // the pull request once new commits are pushed.
  test("a review of an older head does not count", () => {
    const body = `VERDICT: Ship it\nReviewed head SHA: ${"f".repeat(40)}\n`;
    expect(reviewable([pullRequestWithComment(REVIEWER, body)])).toEqual([1]);
  });

  // Catches a fork's pull request being queued: it is never reviewed, so it never gets a stamp
  // and would fail its item on every scheduled run, forever. It must be reported, not dropped
  // silently, so it is returned apart.
  test("sets pull requests from forks apart instead of queueing them or dropping them", () => {
    const own = { ...pullRequestWithComment(null, ""), number: 3 };
    const fork = { ...pullRequestWithComment(null, ""), number: 2, isCrossRepository: true };
    expect(selectUnreviewedPullRequests([own, fork], REVIEWER)).toEqual({
      reviewable: [3],
      forks: [2],
    });
  });

  // Catches a fork's draft or already-reviewed pull request being reported as skipped: the note
  // is about pull requests that would otherwise have been queued.
  test("does not report a fork's draft pull request as skipped", () => {
    const draftFork = {
      ...pullRequestWithComment(null, ""),
      isDraft: true,
      isCrossRepository: true,
    };
    expect(selectUnreviewedPullRequests([draftFork], REVIEWER)).toEqual({
      reviewable: [],
      forks: [],
    });
  });
});

describe("reviewedHeadOfComment", () => {
  test("reads the commit from the stamp line and nothing from a comment without one", () => {
    expect(reviewedHeadOfComment(`VERDICT: Ship it\nReviewed head SHA: ${HEAD}\n`)).toBe(HEAD);
    expect(reviewedHeadOfComment("Looks fine to me.")).toBeUndefined();
  });
});
