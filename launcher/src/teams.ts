// Teams are discovered, not registered: any top-level directory of this repository
// that holds a workflow.yaml is a team. Adding a team means adding a directory;
// moving teams under a subfolder later only needs this one scan to change.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { loadManifest, MANIFEST_FILE_NAME, type WorkflowManifest } from "./manifest.ts";

/**
 * Loads every team manifest found one level below the repository root, sorted by name.
 * @throws Error when any manifest is invalid, or two manifests share a name.
 */
export function discoverTeams(repositoryRoot: string): WorkflowManifest[] {
  const manifests: WorkflowManifest[] = [];
  const directoryEntries = readdirSync(repositoryRoot, { withFileTypes: true });
  for (const directoryEntry of directoryEntries) {
    if (!directoryEntry.isDirectory() || directoryEntry.name.startsWith(".")) {
      continue;
    }
    const manifestPath = join(repositoryRoot, directoryEntry.name, MANIFEST_FILE_NAME);
    if (existsSync(manifestPath)) {
      manifests.push(loadManifest(manifestPath));
    }
  }

  const seenNames = new Set<string>();
  for (const manifest of manifests) {
    if (seenNames.has(manifest.name)) {
      throw new Error(`two team manifests are named '${manifest.name}'`);
    }
    seenNames.add(manifest.name);
  }
  return manifests.toSorted((left, right) => left.name.localeCompare(right.name));
}
