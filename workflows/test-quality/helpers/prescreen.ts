// test-quality-prescreen [target]: runs the j5-test-quality Tier 1 pre-screen in
// strict mode (see launcher/src/test-prescreen.ts). With a target (a file or
// directory, relative to the project root), it scans every test file under it;
// without one, the test files changed since this branch left the remote default
// branch, including uncommitted ones and new files registered with `git add -N`.
// `target` comes from the command line or the environment, where docker-agent's
// test_prescreen tool puts it.
// Exit 0 = no HIGH findings; 1 = HIGH findings; 2 = the pre-screen could not run.
//
// The argument is `target`, not `path`: Windows environment variable names are
// case-insensitive, so a tool argument named `path` would replace PATH.

import {
  HelperUsageError,
  readToolArgument,
  runHelper,
} from "../../../launcher/src/team-helper.ts";
import { runTestPrescreen } from "../../../launcher/src/test-prescreen.ts";

runHelper("test-quality-prescreen", () => {
  const target = readToolArgument("target");
  if (target === undefined) {
    process.exit(runTestPrescreen({ kind: "changes" }));
  }
  // The pre-screen script reads a leading "-" as one of its own options.
  if (target.startsWith("-")) {
    throw new HelperUsageError(`target must be a file or directory, not an option: ${target}`);
  }
  process.exit(runTestPrescreen({ kind: "path", path: target }));
});
