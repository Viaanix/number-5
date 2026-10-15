// Only the remote GitHub read is simulated; every git command uses a real repository.
import { readFileSync } from "node:fs";

const responsePath = process.env.PR_REVIEWER_RESPONSE;
if (Bun.argv[2] !== "pr" || Bun.argv[3] !== "view" || responsePath === undefined) {
  console.error("fixture supports only gh pr view with PR_REVIEWER_RESPONSE");
  process.exit(1);
}
process.stdout.write(readFileSync(responsePath, "utf8"));
