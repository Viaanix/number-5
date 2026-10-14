// Teams are discovered, not registered: any directory directly under workflows/ that
// holds a workflow.yaml is a team. Adding a team means adding a directory there.
// Top-level directories of the repository are never teams, even with a workflow.yaml.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { loadManifest, MANIFEST_FILE_NAME, type WorkflowManifest } from "./manifest.ts";

/** Directory under the repository root whose subdirectories are the teams. */
export const TEAMS_DIRECTORY_NAME = "workflows";

/** Absolute path of the directory that holds one subdirectory per team. */
export function resolveTeamsDirectory(repositoryRoot: string): string {
  return join(repositoryRoot, TEAMS_DIRECTORY_NAME);
}

/**
 * Loads every team manifest found one level below workflows/, sorted by name.
 * A repository without workflows/ has no teams.
 * @throws Error when any manifest is invalid, or two manifests share a name.
 */
export function discoverTeams(repositoryRoot: string): WorkflowManifest[] {
  const teamsDirectory = resolveTeamsDirectory(repositoryRoot);
  if (!existsSync(teamsDirectory)) {
    return [];
  }

  const manifests: WorkflowManifest[] = [];
  const directoryEntries = readdirSync(teamsDirectory, { withFileTypes: true });
  for (const directoryEntry of directoryEntries) {
    if (!directoryEntry.isDirectory() || directoryEntry.name.startsWith(".")) {
      continue;
    }
    const manifestPath = join(teamsDirectory, directoryEntry.name, MANIFEST_FILE_NAME);
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
