// Stands in for `docker` in the launch test. Reports what the launcher actually
// spawned (working directory, first PATH entry, arguments) as one JSON line, then
// exits with a distinctive code so the test can check it is passed through.
import { delimiter } from "node:path";

import { readPathValue } from "../../src/environment.ts";

const FAKE_DOCKER_EXIT_CODE = 7;

console.log(
  JSON.stringify({
    workingDirectory: process.cwd(),
    firstPathEntry: readPathValue(process.env).split(delimiter)[0],
    arguments: process.argv.slice(2),
  }),
);
process.exit(FAKE_DOCKER_EXIT_CODE);
