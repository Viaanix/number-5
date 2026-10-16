// What "already reviewed" means for a queue of pull requests. Shared so the posting side
// (workflows/pr-reviewer/helpers/report.ts refuses a report without the stamp) and the selecting
// side (this queue) cannot drift apart, and so no team imports another's helper.

import { z } from "zod";

/**
 * The line every posted review carries: the commit the review was written against. The first
 * match in a comment is the one that counts, on both sides.
 */
export const REVIEWED_HEAD_LINE = /^Reviewed head SHA: (\S+)\s*$/m;

/** The commit a review comment says it covers, or undefined when the comment carries no stamp. */
export function reviewedHeadOfComment(commentBody: string): string | undefined {
  return REVIEWED_HEAD_LINE.exec(commentBody)?.[1];
}

/**
 * One open pull request as `gh pr list --json number,isDraft,headRefOid,comments` prints it.
 * `author` is null for an account that no longer exists.
 */
export const pullRequestListingsSchema = z.array(
  z.object({
    number: z.number().int().positive(),
    isDraft: z.boolean(),
    headRefOid: z.string().min(1),
    comments: z.array(
      z.object({
        author: z.object({ login: z.string() }).nullable(),
        body: z.string(),
      }),
    ),
  }),
);

export type PullRequestListing = z.infer<typeof pullRequestListingsSchema>[number];

/**
 * The numbers of the pull requests that still need a review, oldest first: not a draft, and no
 * comment by `reviewerLogin` carries a stamp for the pull request's current head. A push after
 * the review changes the head, so the pull request comes back; a draft is skipped because its
 * author has said it is not ready.
 *
 * Only the reviewer's own comments count. Anyone who can comment could otherwise quote the head
 * commit in a stamp line and keep a pull request out of the queue.
 */
export function selectUnreviewedPullRequests(
  pullRequests: readonly PullRequestListing[],
  reviewerLogin: string,
): number[] {
  return pullRequests
    .filter((pullRequest) => {
      if (pullRequest.isDraft) {
        return false;
      }
      return !pullRequest.comments.some(
        (comment) =>
          comment.author?.login === reviewerLogin &&
          reviewedHeadOfComment(comment.body) === pullRequest.headRefOid,
      );
    })
    .map((pullRequest) => pullRequest.number)
    .toSorted((left, right) => left - right);
}
