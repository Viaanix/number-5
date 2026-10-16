// Tests for the shared flavor catalog (launcher/src/flavor-catalog.ts): the catalog's rules, the
// flavors generated from it, how they are written into team.yaml, and how a team's tuning is
// worked out from its workflow.yaml and team.yaml.

import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildFlavors,
  type FlavorCatalog,
  loadFlavorCatalog,
  planTeamFlavors,
  renderGeneratedSection,
  replaceGeneratedSection,
  resolveTuning,
} from "../src/flavor-catalog.ts";
import { loadManifest } from "../src/manifest.ts";
import {
  createTemporaryDirectory,
  removeTemporaryDirectories,
  writeTeamFixture,
} from "./fixtures.ts";

afterAll(removeTemporaryDirectories);

const CATALOG: FlavorCatalog = {
  tiers: { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-4-7" },
  efforts: ["low", "high"],
};

function writeCatalog(yamlText: string): string {
  const catalogPath = join(createTemporaryDirectory(), "flavors.yaml");
  writeFileSync(catalogPath, yamlText);
  return catalogPath;
}

describe("loadFlavorCatalog", () => {
  test("reads tiers and efforts", () => {
    const catalogPath = writeCatalog(
      "tiers:\n  haiku: claude-haiku-5-5\n  opus: claude-opus-4-7\nefforts: [low, high]\n",
    );
    expect(loadFlavorCatalog(catalogPath)).toEqual({
      tiers: { haiku: "claude-haiku-5-5", opus: "claude-opus-4-7" },
      efforts: ["low", "high"],
    });
  });

  // Catches a tier mapped to the wrong model: --model opus would then run Sonnet, and j5's
  // independence rule would read the wrong tier from what it launched.
  test("rejects a tier whose model id is not of that tier", () => {
    const catalogPath = writeCatalog("tiers:\n  opus: claude-sonnet-5-5\nefforts: [high]\n");
    expect(() => loadFlavorCatalog(catalogPath)).toThrow(
      "tiers.opus: 'claude-sonnet-5-5' is not a opus model",
    );
  });

  test("rejects an unknown tier name, an unknown key, no efforts and a repeated effort", () => {
    expect(() => loadFlavorCatalog(writeCatalog("tiers:\n  mini: m\nefforts: [low]\n"))).toThrow();
    expect(() =>
      loadFlavorCatalog(writeCatalog("tiers: {}\nefforts: [low]\nextra: 1\n")),
    ).toThrow();
    expect(() => loadFlavorCatalog(writeCatalog("tiers: {}\nefforts: []\n"))).toThrow();
    expect(() => loadFlavorCatalog(writeCatalog("tiers: {}\nefforts: [low, low]\n"))).toThrow(
      "efforts: a level is listed twice",
    );
  });
});

describe("buildFlavors", () => {
  const TUNING = {
    tunableModels: ["coordinator_model", "builder_model"],
    reviewerModels: ["reviewer_model"],
  };

  test("lists model flavors, then effort flavors, then reviewer flavors", () => {
    expect(Object.keys(buildFlavors(CATALOG, TUNING))).toEqual([
      "model-haiku",
      "model-sonnet",
      "model-opus",
      "effort-low",
      "effort-high",
      "reviewer-on-haiku",
      "reviewer-on-sonnet",
      "reviewer-on-opus",
    ]);
  });

  // Catches --model reaching the reviewer: j5 chooses the reviewer's tier so it differs from the
  // builders', and a model flavor that also moved it would put them on the same tier.
  test("a model flavor patches the tunable models and never the reviewer's", () => {
    const flavors = buildFlavors(CATALOG, TUNING);
    expect(flavors["model-opus"]).toEqual({
      models: {
        coordinator_model: { model: "claude-opus-4-7" },
        builder_model: { model: "claude-opus-4-7" },
      },
    });
  });

  // Catches --effort missing the reviewer, which would review at the default effort while the
  // builders ran at the chosen one.
  test("an effort flavor reaches the tunable models and the reviewer, and sets nothing else", () => {
    expect(buildFlavors(CATALOG, TUNING)["effort-high"]).toEqual({
      models: {
        coordinator_model: { provider_opts: { extra_body: { reasoning_effort: "high" } } },
        builder_model: { provider_opts: { extra_body: { reasoning_effort: "high" } } },
        reviewer_model: { provider_opts: { extra_body: { reasoning_effort: "high" } } },
      },
    });
  });

  test("a reviewer flavor patches only the reviewer's model", () => {
    expect(buildFlavors(CATALOG, TUNING)["reviewer-on-sonnet"]).toEqual({
      models: { reviewer_model: { model: "claude-sonnet-5-5" } },
    });
  });

  // A team with no independence rule has nothing to keep apart; reviewer flavors would be dead.
  test("makes no reviewer flavors for a team without a reviewer", () => {
    const flavorNames = Object.keys(
      buildFlavors(CATALOG, { tunableModels: ["reviewer_model"], reviewerModels: [] }),
    );
    expect(flavorNames.some((flavorName) => flavorName.startsWith("reviewer-on-"))).toBe(false);
  });

  // Catches a catalog without a tier (the proxy cannot serve Fable) still producing a flavor for it.
  test("makes flavors only for the tiers the catalog has", () => {
    const flavorNames = Object.keys(
      buildFlavors({ tiers: { sonnet: "claude-sonnet-5-5" }, efforts: ["low"] }, TUNING),
    );
    expect(flavorNames).toEqual(["model-sonnet", "effort-low", "reviewer-on-sonnet"]);
  });
});

describe("renderGeneratedSection", () => {
  // Catches the hand-rendered YAML drifting from what docker-agent will read: parsed back, it
  // must be exactly the flavors that were built.
  test("is YAML that parses back to the flavors it was built from", () => {
    const flavors = buildFlavors(CATALOG, {
      tunableModels: ["builder_model"],
      reviewerModels: ["reviewer_model"],
    });
    const parsed = Bun.YAML.parse(renderGeneratedSection(flavors));
    expect(parsed).toEqual({ flavors });
  });

  test("is wrapped in the markers the generator replaces", () => {
    const section = renderGeneratedSection(
      buildFlavors(CATALOG, {
        tunableModels: ["builder_model"],
        reviewerModels: [],
      }),
    );
    expect(section.startsWith("# BEGIN GENERATED FLAVORS")).toBe(true);
    expect(section.trimEnd().endsWith("# END GENERATED FLAVORS")).toBe(true);
  });
});

describe("replaceGeneratedSection", () => {
  const SECTION = "# BEGIN GENERATED FLAVORS: new\nflavors: {}\n# END GENERATED FLAVORS\n";

  // Catches the generator eating the hand-written parts of team.yaml around its block.
  test("replaces only what is between the markers", () => {
    const teamYaml =
      "agents: {}\n# note\n# BEGIN GENERATED FLAVORS: old\nflavors:\n  stale: {}\n# END GENERATED FLAVORS\n";
    expect(replaceGeneratedSection(teamYaml, SECTION)).toBe(`agents: {}\n# note\n${SECTION}`);
  });

  test("leaves a current file unchanged", () => {
    const teamYaml = `agents: {}\n${SECTION}`;
    expect(replaceGeneratedSection(teamYaml, SECTION)).toBe(teamYaml);
  });

  // Catches a silent no-op: without markers nothing would be written and nobody told.
  test("refuses a file without the marker block", () => {
    expect(() => replaceGeneratedSection("agents: {}\n", SECTION)).toThrow(
      "no '# BEGIN GENERATED FLAVORS' ... '# END GENERATED FLAVORS' block to replace",
    );
  });

  // `$&` and friends in a replacement string are special to String.replace; a model id never has
  // them today, but the block must be inserted as written whatever it holds.
  test("inserts the block literally", () => {
    const teamYaml = "# BEGIN GENERATED FLAVORS\n# END GENERATED FLAVORS\n";
    const literal = "# BEGIN GENERATED FLAVORS\n# $& $1 $$\n# END GENERATED FLAVORS\n";
    expect(replaceGeneratedSection(teamYaml, literal)).toBe(literal);
  });
});

describe("resolveTuning", () => {
  const TEAM_YAML = `
agents:
  root: { model: builder_model }
  reviewer: { model: reviewer_model }
  loose: { model: anthropic/claude-sonnet-5-5 }
models:
  builder_model: { provider: pi, model: claude-sonnet-5-5 }
  reviewer_model: { provider: pi, model: claude-opus-4-7 }
`;

  test("takes the reviewer's models from the independence reviewer agent", () => {
    expect(resolveTuning(["builder_model"], "reviewer", TEAM_YAML)).toEqual({
      tuning: { tunableModels: ["builder_model"], reviewerModels: ["reviewer_model"] },
      problems: [],
    });
  });

  test("has no reviewer models for a team without an independence rule", () => {
    expect(resolveTuning(["builder_model"], undefined, TEAM_YAML).tuning.reviewerModels).toEqual(
      [],
    );
  });

  // Catches a typo in workflow.yaml generating flavors that patch a model that does not exist:
  // docker-agent accepts that silently and adds an incomplete new model entry instead
  // (docs/docker-agent/gotchas.md).
  test("reports a tunable name that is no model in team.yaml", () => {
    expect(resolveTuning(["builder_modle"], undefined, TEAM_YAML).problems).toEqual([
      "flavors.models: 'builder_modle' is not a model in team.yaml",
    ]);
  });

  // Catches --model moving the reviewer: its tier is j5's to choose.
  test("refuses the reviewer's own model in the tunable list", () => {
    expect(resolveTuning(["reviewer_model"], "reviewer", TEAM_YAML).problems.join()).toContain(
      "is the reviewer's model; --model must not change it",
    );
  });

  // An inline model has no name to patch, so the reviewer flavors could not move it.
  test("refuses an independence reviewer that has no named model", () => {
    expect(resolveTuning(["builder_model"], "loose", TEAM_YAML).problems.join()).toContain(
      "agent 'loose' needs a named model",
    );
    expect(resolveTuning(["builder_model"], "ghost", TEAM_YAML).problems.join()).toContain(
      "agent 'ghost' needs a named model",
    );
  });
});

describe("planTeamFlavors", () => {
  const MANIFEST_HEAD = `
name: sample-team
description: A team used by the tests
team: team.yaml
entrypoints:
  chat:
    description: Talk
    agent: root
    worktree: { mode: none }
    message: "Hello"
`;
  const TEAM_YAML =
    "agents:\n  root: { model: m }\nmodels:\n  m: { provider: pi, model: claude-sonnet-5-5 }\n";

  function loadTeam(manifestTail: string) {
    return loadManifest(
      writeTeamFixture(createTemporaryDirectory(), `${MANIFEST_HEAD}${manifestTail}`, TEAM_YAML),
    );
  }

  test("a team without a flavors block gets no section", () => {
    expect(planTeamFlavors(CATALOG, loadTeam(""))).toEqual({ section: undefined, problems: [] });
  });

  test("a team with one gets the section for its models", () => {
    const { section, problems } = planTeamFlavors(CATALOG, loadTeam("flavors:\n  models: [m]\n"));
    expect(problems).toEqual([]);
    expect(section).toContain(
      "  model-haiku:\n    models:\n      m:\n        model: claude-haiku-5-5",
    );
  });

  test("reports a model that is not in team.yaml instead of generating", () => {
    const { section, problems } = planTeamFlavors(
      CATALOG,
      loadTeam("flavors:\n  models: [nope]\n"),
    );
    expect(section).toBeUndefined();
    expect(problems).toEqual(["flavors.models: 'nope' is not a model in team.yaml"]);
  });
});
