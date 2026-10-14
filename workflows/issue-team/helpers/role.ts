// issue-team-role <role>: prints the prompt of one sub-agent role (roles/<role>.md).
// The entry agents are Claude Code harness agents. They start their tester and
// reviewer with Claude Code's own sub-agent tool, and begin each task with this
// output, so each role prompt is written once, here, instead of pasted into every
// entry point's message in workflow.yaml. `role` comes from the command line or the
// environment.

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  HelperUsageError,
  readToolArgument,
  runHelper,
} from "../../../launcher/src/team-helper.ts";

const ROLES_DIRECTORY = join(import.meta.dir, "..", "roles");
const ROLE_FILE_EXTENSION = ".md";

runHelper("issue-team-role", () => {
  // Only names of files that exist in roles/ are accepted, so a name can never reach
  // outside that directory (e.g. "../team").
  const roleNames = readdirSync(ROLES_DIRECTORY)
    .filter((fileName) => fileName.endsWith(ROLE_FILE_EXTENSION))
    .map((fileName) => basename(fileName, ROLE_FILE_EXTENSION))
    .toSorted();
  const roleName = readToolArgument("role");
  if (roleName === undefined || !roleNames.includes(roleName)) {
    throw new HelperUsageError(`usage: issue-team-role <${roleNames.join("|")}>`);
  }
  process.stdout.write(
    readFileSync(join(ROLES_DIRECTORY, `${roleName}${ROLE_FILE_EXTENSION}`), "utf8"),
  );
});
