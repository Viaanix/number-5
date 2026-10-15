import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..", "..");
const SKILL_DIRECTORY = join(REPOSITORY_ROOT, "skills", "j5-test-quality");
const COPY_DIRECTORY = join(import.meta.dir, "..", "instructions", "skill");

// docker-agent's instruction_file accepts only paths inside the team directory, so the tester
// and reviewer carry copies of these skill files in their prompts. Each pair is [copy, source].
const COPIES: [string, string][] = [
  ["j5-test-quality.md", "SKILL.md"],
  ["generate.md", join("workflows", "generate.md")],
  ["review-single.md", join("workflows", "review-single.md")],
];

describe("issue-team's copies of the j5-test-quality skill", () => {
  // Catches the skill being improved in skills/ while the agents keep running the old method,
  // which nothing else would show: both versions are valid markdown and both load fine.
  test.each(COPIES)("%s is identical to its source", (copyName, sourcePath) => {
    const copyPath = join(COPY_DIRECTORY, copyName);
    expect(existsSync(copyPath)).toBe(true);
    const sourceFullPath = join(SKILL_DIRECTORY, sourcePath);
    expect(
      readFileSync(copyPath, "utf8") === readFileSync(sourceFullPath, "utf8"),
      `refresh it: cp ${sourceFullPath} ${copyPath}`,
    ).toBe(true);
  });
});
