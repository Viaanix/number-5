import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { loadManifest } from "../src/manifest.ts";
import { readTeamConfigSummary } from "../src/team-config.ts";
import { discoverTeams } from "../src/teams.ts";
import {
  buildTeamYaml,
  createTemporaryDirectory,
  removeTemporaryDirectories,
  writeTeamFixture,
} from "./fixtures.ts";

afterAll(removeTemporaryDirectories);

const VALID_MANIFEST_YAML = `
name: sample-team
description: A team used by the tests
team: team.yaml
path: [bin]
entrypoints:
  work-issue:
    description: Work one issue
    agent: root
    parameters:
      issue: { type: integer, label: Issue number }
    worktree: { mode: new, name: "{repo}-issue-{issue}" }
    message: "Work issue #{issue}"
  chat:
    description: Talk in the current checkout
    agent: root
    worktree: { mode: none }
    message: "Hello"
`;

function writeManifest(manifestYaml: string): string {
  return writeTeamFixture(createTemporaryDirectory(), manifestYaml, buildTeamYaml([]));
}

// Replaces the work-issue entry point of the valid manifest with the given YAML lines.
function manifestWithWorkIssue(entryPointYaml: string): string {
  return `
name: sample-team
description: A team used by the tests
team: team.yaml
entrypoints:
  work-issue:
${entryPointYaml}
`;
}

// The work-issue entry point with a queue block; `queueYaml` is indented under it.
function manifestWithQueue(
  queueYaml: string,
  messageYaml = 'message: "Work issue #{issue}"',
): string {
  return manifestWithWorkIssue(`    description: Work one issue
    agent: root
    parameters:
      issue: { type: integer, label: Issue number }
      title: { type: string, label: Title }
    worktree: { mode: new, name: "{repo}-issue-{issue}" }
    ${messageYaml}
    queue:
${queueYaml}`);
}

describe("loadManifest", () => {
  test("resolves team and PATH directories against the manifest's directory and fills defaults", () => {
    const manifestPath = writeManifest(VALID_MANIFEST_YAML);
    const teamDirectory = join(manifestPath, "..");
    const manifest = loadManifest(manifestPath);

    expect(manifest.directory).toBe(teamDirectory);
    expect(manifest.teamConfigPath).toBe(join(teamDirectory, "team.yaml"));
    expect(manifest.pathDirectories).toEqual([join(teamDirectory, "bin")]);
    expect(manifest.entrypoints.chat).toEqual({
      description: "Talk in the current checkout",
      agent: "root",
      parameters: {},
      worktree: { mode: "none" },
      message: "Hello",
    });
  });

  test("rejects a misspelled key instead of ignoring it", () => {
    const manifestPath = writeManifest(
      VALID_MANIFEST_YAML.replace('message: "Hello"', 'mesage: "Hello"'),
    );
    expect(() => loadManifest(manifestPath)).toThrow(/invalid manifest/);
  });

  test("rejects an unknown worktree mode", () => {
    const manifestPath = writeManifest(VALID_MANIFEST_YAML.replace("mode: none", "mode: sandbox"));
    expect(() => loadManifest(manifestPath)).toThrow(/invalid manifest/);
  });

  test("rejects a placeholder in the message that is neither a parameter nor {repo}", () => {
    const manifestPath = writeManifest(
      manifestWithWorkIssue(`    description: d
    agent: root
    parameters:
      issue: { type: integer, label: Issue }
    worktree: { mode: none }
    message: "Work issue #{isue}"`),
    );
    expect(() => loadManifest(manifestPath)).toThrow(
      "entrypoints.work-issue.message: unknown placeholder {isue}",
    );
  });

  test("rejects an unknown placeholder in a new worktree's name", () => {
    const manifestPath = writeManifest(
      manifestWithWorkIssue(`    description: d
    agent: root
    worktree: { mode: new, name: "{repo}-{branch}" }
    message: "Go"`),
    );
    expect(() => loadManifest(manifestPath)).toThrow(
      "entrypoints.work-issue.worktree.name: unknown placeholder {branch}",
    );
  });

  test.each(["project", "effort", "base", "print", "help", "repo"])(
    "rejects a parameter named %p, which the launcher reserves",
    (reservedName) => {
      const manifestPath = writeManifest(
        manifestWithWorkIssue(`    description: d
    agent: root
    parameters:
      ${reservedName}: { type: string, label: L }
    worktree: { mode: none }
    message: "Go"`),
      );
      expect(() => loadManifest(manifestPath)).toThrow(
        `entrypoints.work-issue.parameters.${reservedName}: name is reserved by the launcher`,
      );
    },
  );

  test("rejects a parameter name that cannot be a --flag", () => {
    const manifestPath = writeManifest(
      manifestWithWorkIssue(`    description: d
    agent: root
    parameters:
      Issue_Number: { type: integer, label: L }
    worktree: { mode: none }
    message: "Go"`),
    );
    expect(() => loadManifest(manifestPath)).toThrow(
      "entrypoints.work-issue.parameters.Issue_Number: name must match",
    );
  });

  test("rejects a PR worktree whose PR parameter is undeclared", () => {
    const manifestPath = writeManifest(
      manifestWithWorkIssue(`    description: d
    agent: followup
    worktree: { mode: pr, pull_request_parameter: pr }
    message: "Go"`),
    );
    expect(() => loadManifest(manifestPath)).toThrow(
      "entrypoints.work-issue.worktree.pull_request_parameter: 'pr' is not a declared parameter",
    );
  });

  test("rejects a PR worktree whose PR parameter is a string", () => {
    const manifestPath = writeManifest(
      manifestWithWorkIssue(`    description: d
    agent: followup
    parameters:
      pr: { type: string, label: PR }
    worktree: { mode: pr, pull_request_parameter: pr }
    message: "Go"`),
    );
    expect(() => loadManifest(manifestPath)).toThrow(
      "entrypoints.work-issue.worktree.pull_request_parameter: 'pr' must be an integer parameter",
    );
  });

  test("accepts a queue over an integer parameter whose preamble uses the queue placeholders", () => {
    const manifest = loadManifest(
      writeManifest(
        manifestWithQueue(`      parameter: issue
      preamble: "Item {position} of {count} in {repo}, issue {issue}: {round_limit}."`),
      ),
    );
    expect(manifest.entrypoints["work-issue"]?.queue?.parameter).toBe("issue");
  });

  test("rejects a queue over an undeclared parameter, and over a string parameter", () => {
    expect(() =>
      loadManifest(writeManifest(manifestWithQueue("      parameter: pr\n      preamble: x"))),
    ).toThrow("entrypoints.work-issue.queue.parameter: 'pr' is not a declared parameter");
    expect(() =>
      loadManifest(writeManifest(manifestWithQueue("      parameter: title\n      preamble: x"))),
    ).toThrow("entrypoints.work-issue.queue.parameter: 'title' must be an integer parameter");
  });

  test("rejects an unknown placeholder in the preamble", () => {
    expect(() =>
      loadManifest(
        writeManifest(manifestWithQueue('      parameter: issue\n      preamble: "{rounds}"')),
      ),
    ).toThrow("entrypoints.work-issue.queue.preamble: unknown placeholder {rounds}");
  });

  test("a queue counts issues and approves no tools unless it says otherwise", () => {
    const queue = loadManifest(
      writeManifest(manifestWithQueue("      parameter: issue\n      preamble: x")),
    ).entrypoints["work-issue"]?.queue;
    expect(queue?.items).toBe("issues");
    expect(queue?.approves).toEqual([]);
  });

  test("rejects a kind of queue item it does not know", () => {
    expect(() =>
      loadManifest(
        writeManifest(
          manifestWithQueue("      parameter: issue\n      preamble: x\n      items: branches"),
        ),
      ),
    ).toThrow("items");
  });

  // Catches a queue that approves a tool for unattended runs in a team with no `flavors:` block:
  // the queue-unattended flavor is generated from that block, and docker-agent ignores an unknown
  // --flavor silently, so every queued run would reject the tool.
  test("rejects queue.approves in a manifest without a flavors block", () => {
    expect(() =>
      loadManifest(
        writeManifest(
          manifestWithQueue(
            "      parameter: issue\n      preamble: x\n      approves: [pr_comment]",
          ),
        ),
      ),
    ).toThrow("entrypoints.work-issue.queue.approves: the queue-unattended flavor");
    const withFlavors = `${manifestWithQueue(
      "      parameter: issue\n      preamble: x\n      approves: [pr_comment]",
    )}flavors:\n  models: [m]\n`;
    expect(
      loadManifest(writeManifest(withFlavors)).entrypoints["work-issue"]?.queue?.approves,
    ).toEqual(["pr_comment"]);
  });

  // Catches {round_limit} reaching a single run's prompt, where nothing fills it.
  test("keeps the queue placeholders out of the message", () => {
    expect(() =>
      loadManifest(
        writeManifest(
          manifestWithQueue(
            "      parameter: issue\n      preamble: x",
            'message: "Work {issue}, {round_limit}"',
          ),
        ),
      ),
    ).toThrow("entrypoints.work-issue.message: unknown placeholder {round_limit}");
  });

  test("reserves the queue placeholder names as parameter names", () => {
    const manifestPath = writeManifest(
      manifestWithWorkIssue(`    description: d
    agent: root
    parameters:
      count: { type: integer, label: Count }
    worktree: { mode: none }
    message: "m"`),
    );
    expect(() => loadManifest(manifestPath)).toThrow(
      "entrypoints.work-issue.parameters.count: name is reserved by the launcher",
    );
  });

  test("rejects a manifest whose team file does not exist", () => {
    const manifestPath = writeManifest(
      VALID_MANIFEST_YAML.replace("team: team.yaml", "team: missing.yaml"),
    );
    expect(() => loadManifest(manifestPath)).toThrow(/team: .*missing\.yaml does not exist/);
  });
});

// The layout contract written out, not read from teams.ts: fixtures placed through the
// code under test would move with it, and a scan of the wrong directory would pass.
const TEAMS_DIRECTORY_LAYOUT_NAME = "workflows";

describe("discoverTeams", () => {
  test("loads manifests one level below workflows/, skips directories without one, sorts by name", () => {
    const repositoryRoot = createTemporaryDirectory();
    const teamsDirectory = join(repositoryRoot, TEAMS_DIRECTORY_LAYOUT_NAME);
    writeTeamFixture(
      join(teamsDirectory, "zeta"),
      VALID_MANIFEST_YAML.replace("name: sample-team", "name: zeta-team"),
      buildTeamYaml([]),
    );
    writeTeamFixture(
      join(teamsDirectory, "alpha"),
      VALID_MANIFEST_YAML.replace("name: sample-team", "name: alpha-team"),
      buildTeamYaml([]),
    );
    mkdirSync(join(teamsDirectory, "experiment"));

    expect(discoverTeams(repositoryRoot).map((team) => team.name)).toEqual([
      "alpha-team",
      "zeta-team",
    ]);
  });

  // Catches a scan that still reads the repository root, where teams lived before
  // workflows/ existed: a stray top-level workflow.yaml must not become a team.
  test("ignores a manifest in a top-level directory of the repository", () => {
    const repositoryRoot = createTemporaryDirectory();
    writeTeamFixture(
      join(repositoryRoot, "old-team"),
      VALID_MANIFEST_YAML.replace("name: sample-team", "name: old-team"),
      buildTeamYaml([]),
    );
    writeTeamFixture(
      join(repositoryRoot, TEAMS_DIRECTORY_LAYOUT_NAME, "new-team"),
      VALID_MANIFEST_YAML.replace("name: sample-team", "name: new-team"),
      buildTeamYaml([]),
    );

    expect(discoverTeams(repositoryRoot).map((team) => team.name)).toEqual(["new-team"]);
  });

  // Catches a raw ENOENT from readdirSync, which would replace the launcher's
  // "no team manifests found" message with a stack trace.
  test("returns no teams when workflows/ does not exist", () => {
    expect(discoverTeams(createTemporaryDirectory())).toEqual([]);
  });

  test("rejects two manifests with the same name", () => {
    const repositoryRoot = createTemporaryDirectory();
    const teamsDirectory = join(repositoryRoot, TEAMS_DIRECTORY_LAYOUT_NAME);
    writeTeamFixture(join(teamsDirectory, "one"), VALID_MANIFEST_YAML, buildTeamYaml([]));
    writeTeamFixture(join(teamsDirectory, "two"), VALID_MANIFEST_YAML, buildTeamYaml([]));
    expect(() => discoverTeams(repositoryRoot)).toThrow(
      "two team manifests are named 'sample-team'",
    );
  });
});

describe("readTeamConfigSummary", () => {
  test("reads agent names and the offered tiers and levels in declaration order", () => {
    const manifestPath = writeTeamFixture(
      createTemporaryDirectory(),
      VALID_MANIFEST_YAML,
      buildTeamYaml(["model-opus", "model-haiku", "effort-high", "effort-low"]),
    );
    expect(readTeamConfigSummary(join(manifestPath, "..", "team.yaml"))).toEqual({
      agentNames: ["root"],
      modelTiers: ["opus", "haiku"],
      effortLevels: ["high", "low"],
      reviewerFlavorNames: [],
      otherFlavorNames: [],
    });
  });

  // Catches the reviewer's flavors showing up as user choices: `--model` would then accept
  // `reviewer-on-opus`'s tier by another name, and the prompt and `j5 list` would offer a choice
  // the user must never make.
  test("keeps the reviewer-on-<tier> flavors out of the models and efforts", () => {
    const manifestPath = writeTeamFixture(
      createTemporaryDirectory(),
      VALID_MANIFEST_YAML,
      buildTeamYaml(["effort-low", "reviewer-on-opus", "reviewer-on-sonnet"]),
    );
    const summary = readTeamConfigSummary(join(manifestPath, "..", "team.yaml"));
    expect(summary.effortLevels).toEqual(["low"]);
    expect(summary.modelTiers).toEqual([]);
    expect(summary.reviewerFlavorNames).toEqual(["reviewer-on-opus", "reviewer-on-sonnet"]);
  });

  // Catches a hand-written flavor that no option can reach going unnoticed.
  test("lists a flavor with a non-standard name apart", () => {
    const manifestPath = writeTeamFixture(
      createTemporaryDirectory(),
      VALID_MANIFEST_YAML,
      buildTeamYaml(["low", "effort-low"]),
    );
    const summary = readTeamConfigSummary(join(manifestPath, "..", "team.yaml"));
    expect(summary.otherFlavorNames).toEqual(["low"]);
    expect(summary.effortLevels).toEqual(["low"]);
  });

  test("reports no offered values for a team without a flavors section", () => {
    const manifestPath = writeTeamFixture(
      createTemporaryDirectory(),
      VALID_MANIFEST_YAML,
      buildTeamYaml([]),
    );
    const summary = readTeamConfigSummary(join(manifestPath, "..", "team.yaml"));
    expect([summary.modelTiers, summary.effortLevels]).toEqual([[], []]);
  });

  test("rejects a file with no agents map", () => {
    const manifestPath = writeTeamFixture(
      createTemporaryDirectory(),
      VALID_MANIFEST_YAML,
      "models: {}\n",
    );
    expect(() => readTeamConfigSummary(join(manifestPath, "..", "team.yaml"))).toThrow(
      /not a team config/,
    );
  });
});
