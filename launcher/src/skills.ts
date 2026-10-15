// Installing this package's skills (skills/<name>) into the user's home directory.
//
// Shared by `j5 setup` and scripts/install.ts. Skills are copied, never linked: docker-agent
// skips symlinked skill directories. Only directories that carry the marker file are ever
// replaced or removed, so a skill someone else put in the same place is never touched.

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

// Where docker-agent looks for skills in the home directory (pkg/skills/local.go).
const INSTALLED_SKILLS_RELATIVE_DIRECTORY = join(".agents", "skills");
const SKILLS_SOURCE_DIRECTORY_NAME = "skills";

/** Written into each skill copy; only directories holding it are replaced or removed. */
export const INSTALLED_SKILL_MARKER_FILE = ".installed-by-number-5";

/** A skill shipped in this package and where it is installed. */
export type SkillPlacement = { skillName: string; sourcePath: string; installedPath: string };

/**
 * What is at a skill's install location:
 * - `missing`: nothing there yet;
 * - `current`: installed by number-5 and identical to the shipped skill;
 * - `stale`: installed by number-5 but different, for example after an upgrade;
 * - `foreign`: something else is there (no marker), which is never replaced.
 */
export type SkillState = "missing" | "current" | "stale" | "foreign";

/** Lists the skills under <packageRoot>/skills and where each belongs in the home directory. */
export function listSkillPlacements(packageRoot: string, homeDirectory: string): SkillPlacement[] {
  const skillsSourceDirectory = join(packageRoot, SKILLS_SOURCE_DIRECTORY_NAME);
  if (!existsSync(skillsSourceDirectory)) {
    return [];
  }
  return readdirSync(skillsSourceDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      skillName: entry.name,
      sourcePath: join(skillsSourceDirectory, entry.name),
      installedPath: join(homeDirectory, INSTALLED_SKILLS_RELATIVE_DIRECTORY, entry.name),
    }))
    .toSorted((left, right) => left.skillName.localeCompare(right.skillName));
}

/** True when the directory was written by {@link copySkill}. */
export function wasInstalledByNumber5(installedPath: string): boolean {
  return existsSync(join(installedPath, INSTALLED_SKILL_MARKER_FILE));
}

/** Replaces whatever is at the install location with a fresh copy and the marker file. */
export function copySkill(placement: SkillPlacement): void {
  rmSync(placement.installedPath, { recursive: true, force: true });
  cpSync(placement.sourcePath, placement.installedPath, { recursive: true });
  writeFileSync(
    join(placement.installedPath, INSTALLED_SKILL_MARKER_FILE),
    `Copied from ${placement.sourcePath} by number-5 (j5 setup or scripts/install.ts).\nRe-run either to refresh; edits here are overwritten.\n`,
  );
}

function listFilesRecursively(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .toSorted();
}

/** Compares two directory trees by file names and bytes, ignoring the install marker. */
function haveSameContent(sourcePath: string, installedPath: string): boolean {
  const sourceFiles = listFilesRecursively(sourcePath);
  const installedFiles = listFilesRecursively(installedPath).filter(
    (file) => file !== INSTALLED_SKILL_MARKER_FILE,
  );
  if (sourceFiles.length !== installedFiles.length) {
    return false;
  }
  return sourceFiles.every(
    (file, index) =>
      file === installedFiles[index] &&
      readFileSync(join(sourcePath, file)).equals(readFileSync(join(installedPath, file))),
  );
}

/** Reports what is at the skill's install location without changing anything. */
export function inspectSkill(placement: SkillPlacement): SkillState {
  if (!existsSync(placement.installedPath)) {
    return "missing";
  }
  if (!wasInstalledByNumber5(placement.installedPath)) {
    return "foreign";
  }
  return haveSameContent(placement.sourcePath, placement.installedPath) ? "current" : "stale";
}
