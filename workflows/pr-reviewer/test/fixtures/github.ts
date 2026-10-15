// Only the remote GitHub calls are simulated; every git command uses a real repository.
// `pr view` replays PR_REVIEWER_RESPONSE. `pr comment --body-file -` records the body it
// receives on stdin to PR_REVIEWER_COMMENT, as the real command would send it.
import { readFileSync, writeFileSync } from "node:fs";

const responsePath = process.env.PR_REVIEWER_RESPONSE;
const commentPath = process.env.PR_REVIEWER_COMMENT;
const [command, subcommand, , ...flags] = Bun.argv.slice(2);

if (command === "pr" && subcommand === "view" && responsePath !== undefined) {
  process.stdout.write(readFileSync(responsePath, "utf8"));
} else if (
  command === "pr" &&
  subcommand === "comment" &&
  commentPath !== undefined &&
  flags.join(" ") === "--body-file -"
) {
  writeFileSync(commentPath, await Bun.stdin.text());
  console.log("https://github.com/example/review-app/pull/37#issuecomment-1");
} else {
  console.error("fixture supports only gh pr view and gh pr comment --body-file -");
  process.exit(1);
}
