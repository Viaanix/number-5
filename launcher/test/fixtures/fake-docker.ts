// Stands in for `docker` in the launch test. Reports what the launcher actually
// spawned (working directory, first PATH entry, arguments) as one JSON line, then
// exits with a distinctive code so the test can check it is passed through.
// `docker agent debug config` is answered like the real thing (fake-debug-config.ts).
import { delimiter } from "node:path";

import { readPathValue } from "../../src/environment.ts";
import { answerDebugConfigCall } from "./fake-debug-config.ts";

const FAKE_DOCKER_EXIT_CODE = 7;
const dockerArguments = process.argv.slice(2);

answerDebugConfigCall(dockerArguments);

console.log(
  JSON.stringify({
    workingDirectory: process.cwd(),
    firstPathEntry: readPathValue(process.env).split(delimiter)[0],
    arguments: dockerArguments,
  }),
);
process.exit(FAKE_DOCKER_EXIT_CODE);
