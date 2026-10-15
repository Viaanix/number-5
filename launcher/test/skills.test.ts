// Tests for the shared skill installer. Every test uses temporary directories; none can reach
// the real ~/.agents/skills.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  copySkill,
  INSTALLED_SKILL_MARKER_FILE,
  inspectSkill,
  listSkillPlacements,
} from "../src/skills.ts";
import { createTemporaryDirectory, removeTemporaryDirectories } from "./fixtures.ts";

afterAll(removeTemporaryDirectories);

/** A package root with skills/<name>/ directories holding the given files. */
function createPackageWithSkills(skills: Record<string, Record<string, string>>): string {
  const packageRoot = createTemporaryDirectory();
  for (const [skillName, files] of Object.entries(skills)) {
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = join(packageRoot, "skills", skillName, relativePath);
      mkdirSync(join(filePath, ".."), { recursive: true });
      writeFileSync(filePath, content);
    }
  }
  return packageRoot;
}

describe("listSkillPlacements", () => {
  test("lists skill directories sorted by name and ignores loose files", () => {
    const packageRoot = createPackageWithSkills({
      zebra: { "SKILL.md": "z" },
      alpha: { "SKILL.md": "a" },
    });
    writeFileSync(join(packageRoot, "skills", "README.md"), "not a skill");
    const homeDirectory = createTemporaryDirectory();

    const placements = listSkillPlacements(packageRoot, homeDirectory);

    expect(placements.map((placement) => placement.skillName)).toEqual(["alpha", "zebra"]);
    expect(placements[0]?.installedPath).toBe(join(homeDirectory, ".agents", "skills", "alpha"));
  });

  test("a package without a skills directory has no placements", () => {
    expect(listSkillPlacements(createTemporaryDirectory(), createTemporaryDirectory())).toEqual([]);
  });
});

describe("inspectSkill", () => {
  test("reports missing, then current once copied", () => {
    const packageRoot = createPackageWithSkills({ demo: { "SKILL.md": "v1" } });
    const [placement] = listSkillPlacements(packageRoot, createTemporaryDirectory());
    if (placement === undefined) {
      throw new Error("fixture has no skill");
    }

    expect(inspectSkill(placement)).toBe("missing");
    copySkill(placement);
    expect(inspectSkill(placement)).toBe("current");
  });

  // Catches an upgrade that ships a changed skill while the installed copy still looks fine
  // because the marker file is there: the refresh would never run and agents would read old text.
  test("reports stale when the shipped skill changed after it was installed", () => {
    const packageRoot = createPackageWithSkills({ demo: { "SKILL.md": "v1" } });
    const [placement] = listSkillPlacements(packageRoot, createTemporaryDirectory());
    if (placement === undefined) {
      throw new Error("fixture has no skill");
    }
    copySkill(placement);

    writeFileSync(join(placement.sourcePath, "SKILL.md"), "v2");

    expect(inspectSkill(placement)).toBe("stale");
  });

  test("reports stale when the shipped skill gained a file", () => {
    const packageRoot = createPackageWithSkills({ demo: { "SKILL.md": "v1" } });
    const [placement] = listSkillPlacements(packageRoot, createTemporaryDirectory());
    if (placement === undefined) {
      throw new Error("fixture has no skill");
    }
    copySkill(placement);

    mkdirSync(join(placement.sourcePath, "checklists"), { recursive: true });
    writeFileSync(join(placement.sourcePath, "checklists", "new.md"), "new");

    expect(inspectSkill(placement)).toBe("stale");
  });

  test("reports stale when the installed copy was edited by hand", () => {
    const packageRoot = createPackageWithSkills({ demo: { "SKILL.md": "v1" } });
    const [placement] = listSkillPlacements(packageRoot, createTemporaryDirectory());
    if (placement === undefined) {
      throw new Error("fixture has no skill");
    }
    copySkill(placement);

    writeFileSync(join(placement.installedPath, "SKILL.md"), "edited");

    expect(inspectSkill(placement)).toBe("stale");
  });

  // Catches a directory someone else made being treated as ours, and then overwritten.
  test("reports foreign for a directory without the marker", () => {
    const packageRoot = createPackageWithSkills({ demo: { "SKILL.md": "v1" } });
    const [placement] = listSkillPlacements(packageRoot, createTemporaryDirectory());
    if (placement === undefined) {
      throw new Error("fixture has no skill");
    }
    mkdirSync(placement.installedPath, { recursive: true });
    writeFileSync(join(placement.installedPath, "SKILL.md"), "someone else's");

    expect(inspectSkill(placement)).toBe("foreign");
  });
});

describe("copySkill", () => {
  // Catches a refresh that copies over the old directory and leaves behind a file the new
  // version dropped, which would keep telling agents to read something that no longer exists.
  test("removes files the new version no longer ships", () => {
    const packageRoot = createPackageWithSkills({
      demo: { "SKILL.md": "v1", "old-checklist.md": "old" },
    });
    const [placement] = listSkillPlacements(packageRoot, createTemporaryDirectory());
    if (placement === undefined) {
      throw new Error("fixture has no skill");
    }
    copySkill(placement);
    expect(existsSync(join(placement.installedPath, "old-checklist.md"))).toBe(true);

    rmSync(join(placement.sourcePath, "old-checklist.md"));
    copySkill(placement);

    expect(existsSync(join(placement.installedPath, "old-checklist.md"))).toBe(false);
    expect(readFileSync(join(placement.installedPath, "SKILL.md"), "utf8")).toBe("v1");
    expect(existsSync(join(placement.installedPath, INSTALLED_SKILL_MARKER_FILE))).toBe(true);
  });
});
