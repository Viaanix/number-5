// Stands in for `gh` in the pull request queue tests. It answers the two calls the launcher makes:
//   gh api user --jq .login   → prints FAKE_GH_LOGIN
//   gh pr list ...            → prints the file FAKE_GH_PR_LIST (a JSON array)
// and appends every call, as one line, to the file FAKE_GH_LOG. FAKE_GH_FAIL makes every call fail
// with that text on stderr, as an expired login does.
import { appendFileSync, readFileSync } from "node:fs";

const FAILURE_EXIT_CODE = 1;
const UNEXPECTED_CALL_EXIT_CODE = 2;

const commandArguments = process.argv.slice(2);
const logPath = process.env["FAKE_GH_LOG"];
if (logPath !== undefined) {
  appendFileSync(logPath, `${commandArguments.join(" ")}\n`);
}

const failureText = process.env["FAKE_GH_FAIL"];
if (failureText !== undefined) {
  console.error(failureText);
  process.exit(FAILURE_EXIT_CODE);
}

if (commandArguments[0] === "api" && commandArguments[1] === "user") {
  console.log(process.env["FAKE_GH_LOGIN"] ?? "");
} else if (commandArguments[0] === "pr" && commandArguments[1] === "list") {
  process.stdout.write(readFileSync(process.env["FAKE_GH_PR_LIST"] ?? "", "utf8"));
} else {
  console.error(`fake gh: unexpected call: ${commandArguments.join(" ")}`);
  process.exit(UNEXPECTED_CALL_EXIT_CODE);
}
