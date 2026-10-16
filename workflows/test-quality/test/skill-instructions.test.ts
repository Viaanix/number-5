import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..", "..");
const SKILL_DIRECTORY = join(REPOSITORY_ROOT, "skills", "j5-test-quality");
const TEAM_DIRECTORY = resolve(import.meta.dir, "..");
const COPY_DIRECTORY = join(TEAM_DIRECTORY, "instructions", "skill");

// docker-agent's instruction_file accepts only paths inside the team directory, so each agent
// carries copies of the skill files it follows in its prompt. Each pair is [copy, source].
const COPIES: [string, string][] = [
  ["j5-test-quality.md", "SKILL.md"],
  ["review-at-scale.md", join("workflows", "review-at-scale.md")],
  ["review-single.md", join("workflows", "review-single.md")],
  ["generate.md", join("workflows", "generate.md")],
  ["maintain-failing.md", join("workflows", "maintain-failing.md")],
  ["mock-antipatterns.md", join("checklists", "mock-antipatterns.md")],
  ["fig-leaf-signals.md", join("checklists", "fig-leaf-signals.md")],
  ["pre-claim.md", join("checklists", "pre-claim.md")],
  ["assertion-shape.md", join("references", "assertion-shape.md")],
];

describe("test-quality's copies of the j5-test-quality skill", () => {
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

  // Catches a copy left behind after it was dropped from the list (nothing checks it against
  // its source any more, so it would go stale while still looking like part of the skill).
  test("the copy directory holds exactly the listed files", () => {
    expect(readdirSync(COPY_DIRECTORY).toSorted()).toEqual(
      COPIES.map(([copyName]) => copyName).toSorted(),
    );
  });

  // Catches a team.yaml instruction_file entry whose file was renamed or never created:
  // docker-agent would fail only when that agent starts, and `j5 ... --print` would not show it.
  test("every instruction_file listed in team.yaml exists", () => {
    const teamYaml = readFileSync(join(TEAM_DIRECTORY, "team.yaml"), "utf8");
    const listedPaths = [
      ...teamYaml.matchAll(/^\s*(?:-|instruction_file:)\s+(instructions\/\S+\.md)\s*$/gm),
    ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
    expect(listedPaths.length).toBeGreaterThan(COPIES.length);
    for (const listedPath of listedPaths) {
      expect(existsSync(join(TEAM_DIRECTORY, listedPath)), listedPath).toBe(true);
    }
  });
});
