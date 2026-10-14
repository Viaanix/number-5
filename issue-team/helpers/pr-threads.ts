// issue-team-pr-threads <pr>: prints the unresolved review threads of a pull request
// in the current repository, one JSON object per line (thread id, outdated flag,
// path, line, comments). `pr` comes from the command line or the environment
// (docker-agent's pr_threads tool sets it as an environment variable).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { HelperUsageError, readToolArgument, runAndCapture, runHelper } from "./command.ts";

// Pull request numbers: digits only.
const PULL_REQUEST_NUMBER_PATTERN = /^[0-9]+$/;
const MAXIMUM_THREADS = 100;
const MAXIMUM_COMMENTS_PER_THREAD = 50;

// $owner, $name and $pr are GraphQL variables; gh fills them from the -f/-F flags.
const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: ${MAXIMUM_THREADS}) {
        nodes {
          id isResolved isOutdated path line
          comments(first: ${MAXIMUM_COMMENTS_PER_THREAD}) { nodes { databaseId author { login } body url } }
        }
      }
    }
  }
}`;

// Only the fields the helper relies on are checked; every other field of a thread
// (id, isOutdated, path, line, comments) is passed through as GitHub returned it.
const reviewThreadsResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewThreads: z.object({
          nodes: z.array(z.looseObject({ isResolved: z.boolean() })),
        }),
      }),
    }),
  }),
});

const repositorySchema = z.object({ owner: z.object({ login: z.string() }), name: z.string() });

runHelper("issue-team-pr-threads", () => {
  const pullRequestNumber = readToolArgument("pr");
  if (pullRequestNumber === undefined) {
    throw new HelperUsageError(
      "usage: issue-team-pr-threads <pr-number> (or pr in the environment)",
    );
  }
  if (!PULL_REQUEST_NUMBER_PATTERN.test(pullRequestNumber)) {
    throw new HelperUsageError(`not a PR number: ${pullRequestNumber}`);
  }

  const repository = repositorySchema.parse(
    JSON.parse(runAndCapture(["gh", "repo", "view", "--json", "owner,name"])),
  );
  const owner = repository.owner.login;
  const name = repository.name;

  // The multi-line query goes to gh as a file (`-F query=@<file>`), never as an
  // argument: Bun refuses to pass newlines and other cmd.exe special characters to a
  // .cmd program (a gh installed as a .cmd shim on Windows, or a test double).
  const queryDirectory = mkdtempSync(join(tmpdir(), "issue-team-pr-threads-"));
  let response: z.infer<typeof reviewThreadsResponseSchema>;
  try {
    const queryPath = join(queryDirectory, "review-threads.graphql");
    writeFileSync(queryPath, REVIEW_THREADS_QUERY);
    response = reviewThreadsResponseSchema.parse(
      JSON.parse(
        runAndCapture([
          "gh",
          "api",
          "graphql",
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
          "-F",
          `pr=${pullRequestNumber}`,
          "-F",
          `query=@${queryPath}`,
        ]),
      ),
    );
  } finally {
    rmSync(queryDirectory, { recursive: true, force: true });
  }

  for (const thread of response.data.repository.pullRequest.reviewThreads.nodes) {
    if (thread.isResolved) {
      continue;
    }
    const { isResolved: _resolvedFlag, ...unresolvedThread } = thread;
    console.log(JSON.stringify(unresolvedThread));
  }
});
