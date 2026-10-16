// Writes every team's standard flavors (model-<tier>, effort-<level>, reviewer-on-<tier>) into the
// marker block at the end of its team.yaml, from workflows/flavors.yaml and the `flavors:` block of
// its workflow.yaml. See launcher/src/flavor-catalog.ts for why they are generated.
//
//   bun run flavors          rewrite the blocks that are out of date
//   bun run flavors --check  change nothing; exit 1 when a block is out of date
//
// `bun run validate:teams` runs the same comparison, so a stale block fails `bun run check`.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  FLAVOR_CATALOG_FILE_NAME,
  loadFlavorCatalog,
  planTeamFlavors,
  replaceGeneratedSection,
} from "#launcher/flavor-catalog.ts";
import { discoverTeams, resolveTeamsDirectory } from "#launcher/teams.ts";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const CHECK_SWITCH = "--check";

function main(): number {
  const checkOnly = process.argv.slice(2).includes(CHECK_SWITCH);
  const catalog = loadFlavorCatalog(
    join(resolveTeamsDirectory(REPOSITORY_ROOT), FLAVOR_CATALOG_FILE_NAME),
  );
  let outOfDateCount = 0;
  let failed = false;
  for (const team of discoverTeams(REPOSITORY_ROOT)) {
    const { section, problems } = planTeamFlavors(catalog, team);
    if (problems.length > 0) {
      failed = true;
      console.error(`${team.name}:\n  ${problems.join("\n  ")}`);
      continue;
    }
    if (section === undefined) {
      continue;
    }
    const current = readFileSync(team.teamConfigPath, "utf8");
    let updated: string;
    try {
      updated = replaceGeneratedSection(current, section);
    } catch (error) {
      failed = true;
      console.error(`${team.name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (updated === current) {
      console.log(`ok       ${team.name}`);
      continue;
    }
    outOfDateCount += 1;
    if (checkOnly) {
      console.log(`stale    ${team.name}`);
    } else {
      writeFileSync(team.teamConfigPath, updated);
      console.log(`updated  ${team.name}`);
    }
  }
  return failed || (checkOnly && outOfDateCount > 0) ? 1 : 0;
}

process.exit(main());
