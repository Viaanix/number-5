// issue-team-change-diff [since]: prints the change under review (see
// launcher/src/change-diff.ts). `since`, the last reviewed HEAD, comes from the
// command line or the environment (docker-agent's change_diff tool sets it as an
// environment variable).

import { formatChangeDiff } from "#launcher/change-diff.ts";
import { readToolArgument, runHelper } from "#launcher/team-helper.ts";

runHelper("issue-team-change-diff", () => {
  process.stdout.write(formatChangeDiff(readToolArgument("since")));
});
