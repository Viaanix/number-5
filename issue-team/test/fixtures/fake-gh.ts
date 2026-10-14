// Stands in for the GitHub CLI in the pr-threads tests. Answers the two calls the
// helper makes: `gh repo view --json owner,name` with a fixed repository, and
// `gh api graphql ...` with the JSON file named in FAKE_GH_GRAPHQL_RESPONSE, after
// appending its arguments as one JSON line to the file named in FAKE_GH_LOG.
import { appendFileSync, readFileSync } from "node:fs";

const commandArguments = process.argv.slice(2);
const [subcommand] = commandArguments;

if (subcommand === "repo") {
  console.log(JSON.stringify({ owner: { login: "acme" }, name: "widgets" }));
} else if (subcommand === "api") {
  const logPath = process.env.FAKE_GH_LOG;
  const responsePath = process.env.FAKE_GH_GRAPHQL_RESPONSE;
  if (logPath === undefined || responsePath === undefined) {
    console.error("fake gh: FAKE_GH_LOG and FAKE_GH_GRAPHQL_RESPONSE must be set");
    process.exit(1);
  }
  appendFileSync(logPath, `${JSON.stringify(commandArguments)}\n`);
  process.stdout.write(readFileSync(responsePath, "utf8"));
} else {
  console.error(`fake gh: unexpected arguments ${JSON.stringify(commandArguments)}`);
  process.exit(1);
}
