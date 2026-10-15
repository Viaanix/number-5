// One page of the verified PR's changed paths, diff stat and full diff. Every page
// carries the snapshot OIDs and the whole stream's fingerprint, so a page from a
// different snapshot is detectable. Read-only: never refresh or repair the checkout.

import { HelperUsageError, runHelper } from "../../../launcher/src/team-helper.ts";
import {
  buildDiffStream,
  fingerprint,
  PAGE_CONTENT_BYTE_LIMIT,
  paginate,
  parsePullRequestNumber,
  readSnapshot,
  verifyCheckout,
} from "./snapshot.ts";

function parsePageNumber(): number {
  const argument = process.env.page;
  if (
    argument === undefined ||
    !/^[1-9][0-9]*$/.test(argument) ||
    !Number.isSafeInteger(Number(argument))
  ) {
    throw new HelperUsageError("page must be a positive safe integer (usage: page=<n> pr=<n>)");
  }
  return Number(argument);
}

runHelper("pr-reviewer-diff", () => {
  const pullRequestNumber = parsePullRequestNumber();
  const pageNumber = parsePageNumber();
  const snapshot = readSnapshot(pullRequestNumber);
  verifyCheckout(snapshot.headRefOid);
  const stream = buildDiffStream(snapshot);
  verifyCheckout(snapshot.headRefOid);
  const pages = paginate(stream.text, PAGE_CONTENT_BYTE_LIMIT);
  const page = pages[pageNumber - 1];
  if (page === undefined) {
    throw new Error(
      `page ${pageNumber} is out of range; this diff has pages 1 through ${pages.length}.`,
    );
  }
  const label = `${pageNumber} OF ${pages.length}`;
  const { sha256, bytes } = fingerprint(stream.text);
  console.log(`BEGIN PR DIFF PAGE ${label}`);
  console.log(
    `snapshot: head=${snapshot.headRefOid} base=${snapshot.baseRefOid} mergeBase=${stream.mergeBaseOid}`,
  );
  console.log(`diff: sha256=${sha256} bytes=${bytes}`);
  process.stdout.write(page);
  if (!page.endsWith("\n")) {
    console.log();
  }
  console.log(`END PR DIFF PAGE ${label}`);
});
