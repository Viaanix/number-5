// Tests that every j5 agent carries the j5-craft skill, and that the copy each team ships is the
// skill. They read the real team.yaml files and skill files; nothing is mocked.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { z } from "zod";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..");
const SKILL_PATH = join(REPOSITORY_ROOT, "skills", "j5-craft", "SKILL.md");
const WORKFLOWS_DIRECTORY = join(REPOSITORY_ROOT, "workflows");
// docker-agent's instruction_file accepts only paths inside the team directory, so each team
// carries a copy of the skill; it is listed first so it frames everything the role says.
const CRAFT_INSTRUCTION = "instructions/j5-craft.md";

const teamYamlSchema = z.looseObject({
  agents: z
    .record(
      z.string(),
      z.looseObject({ instruction_file: z.union([z.string(), z.array(z.string())]).optional() }),
    )
    .optional(),
});

type TeamAgents = { teamName: string; agents: Array<{ agentName: string; files: string[] }> };

function readTeams(): TeamAgents[] {
  return readdirSync(WORKFLOWS_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(WORKFLOWS_DIRECTORY, entry.name, "team.yaml")))
    .map((entry) => {
      const parsed = teamYamlSchema.parse(
        Bun.YAML.parse(readFileSync(join(WORKFLOWS_DIRECTORY, entry.name, "team.yaml"), "utf8")),
      );
      const agents = Object.entries(parsed.agents ?? {}).map(([agentName, agent]) => {
        const listed = agent.instruction_file ?? [];
        return { agentName, files: typeof listed === "string" ? [listed] : listed };
      });
      return { teamName: entry.name, agents };
    });
}

const TEAMS = readTeams();

describe("the j5-craft skill in every team", () => {
  test("there are teams to check, each with agents", () => {
    expect(TEAMS.length).toBeGreaterThan(0);
    for (const team of TEAMS) {
      expect(team.agents.length, team.teamName).toBeGreaterThan(0);
    }
  });

  // Catches a new agent, or an edit that drops the entry or reorders it, leaving that agent
  // without the rule that its claims need receipts. Nothing else would show it: the agent runs,
  // and its reports just stop saying how they know.
  test.each(TEAMS.flatMap((team) => team.agents.map((agent) => [team.teamName, agent] as const)))(
    "%s: every agent lists the craft skill first",
    (teamName, agent) => {
      expect(agent.files[0], `${teamName}/${agent.agentName}`).toBe(CRAFT_INSTRUCTION);
    },
  );

  // Catches the skill being sharpened in skills/ while the agents keep running the old text:
  // both versions load fine, so only a byte comparison shows the difference.
  test.each(TEAMS.map((team) => [team.teamName] as const))(
    "%s: its copy is identical to skills/j5-craft/SKILL.md",
    (teamName) => {
      const copyPath = join(WORKFLOWS_DIRECTORY, teamName, CRAFT_INSTRUCTION);
      expect(existsSync(copyPath), copyPath).toBe(true);
      expect(
        readFileSync(copyPath, "utf8") === readFileSync(SKILL_PATH, "utf8"),
        `refresh it: cp ${SKILL_PATH} ${copyPath}`,
      ).toBe(true);
    },
  );
});
