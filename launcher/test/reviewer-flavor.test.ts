// Tests for the launch-time step of the independence rule (launcher/src/reviewer-flavor.ts).
// Real team.yaml and workflow.yaml fixtures on disk; docker-agent's merged config is played by a
// stand-in that applies flavor patches the way team.yaml would, so no Docker is needed.

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { IndependenceError } from "../src/independence.ts";
import { loadManifest, type WorkflowManifest } from "../src/manifest.ts";
import { chooseAutomaticFlavors } from "../src/reviewer-flavor.ts";
import type { DockerAgentRunner } from "../src/team-models.ts";
import {
  createTemporaryDirectory,
  removeTemporaryDirectories,
  writeTeamFixture,
} from "./fixtures.ts";

afterAll(removeTemporaryDirectories);

const MANIFEST_YAML = `
name: sample-team
description: A team used by the tests
team: team.yaml
entrypoints:
  chat:
    description: Talk
    agent: root
    worktree: { mode: none }
    message: "Hello"
independence:
  reviewer: reviewer
  reviews: [builder, tester]
`;

function teamYaml(reviewerFlavors: string[]): string {
  const flavors = [
    "  low: {}",
    "  max: {}",
    ...reviewerFlavors.map((flavorName) => `  ${flavorName}: {}`),
  ];
  return `agents:
  root: { model: builder_model }
  builder: { model: builder_model }
  tester: { model: builder_model }
  reviewer: { model: reviewer_model }
flavors:
${flavors.join("\n")}
`;
}

function loadTeam(reviewerFlavors: string[], manifestYaml = MANIFEST_YAML): WorkflowManifest {
  return loadManifest(
    writeTeamFixture(createTemporaryDirectory(), manifestYaml, teamYaml(reviewerFlavors)),
  );
}

type ModelPatch = { builder?: string; reviewer?: string };

/**
 * A stand-in for `docker agent debug config`: the base models, then each --flavor's patch in
 * order. `ignoredFlavors` are accepted but change nothing (a flavor that patches the wrong key).
 */
function standInDockerAgent(
  patches: Record<string, ModelPatch>,
  options: { base?: ModelPatch; ignoredFlavors?: string[]; calls?: string[][] } = {},
): DockerAgentRunner {
  return (dockerAgentArguments) => {
    options.calls?.push(dockerAgentArguments);
    let builder = options.base?.builder ?? "claude-sonnet-5-5";
    let reviewer = options.base?.reviewer ?? "claude-opus-4-7";
    dockerAgentArguments.forEach((argument, index) => {
      const flavorName = dockerAgentArguments[index - 1] === "--flavor" ? argument : undefined;
      if (flavorName === undefined || options.ignoredFlavors?.includes(flavorName) === true) {
        return;
      }
      builder = patches[flavorName]?.builder ?? builder;
      reviewer = patches[flavorName]?.reviewer ?? reviewer;
    });
    return {
      exitCode: 0,
      standardError: "",
      standardOutput: JSON.stringify({
        agents: {
          root: { model: "builder_model" },
          builder: { model: "builder_model" },
          tester: { model: "builder_model" },
          reviewer: { model: "reviewer_model" },
        },
        models: {
          builder_model: { provider: "pi", model: builder },
          reviewer_model: { provider: "pi", model: reviewer },
        },
      }),
    };
  };
}

const PATCHES: Record<string, ModelPatch> = {
  "model-haiku": { builder: "claude-haiku-5-5" },
  "model-sonnet": { builder: "claude-sonnet-5-5" },
  "model-opus": { builder: "claude-opus-4-7" },
  "model-fable": { builder: "claude-fable-5-1" },
  // An effort flavor patches no model id, so it must never move a tier.
  "effort-xhigh": {},
  "reviewer-on-sonnet": { reviewer: "claude-sonnet-5-5" },
  "reviewer-on-opus": { reviewer: "claude-opus-4-7" },
  "reviewer-on-haiku": { reviewer: "claude-haiku-5-5" },
  "reviewer-on-fable": { reviewer: "claude-fable-5-1" },
};

const SONNET_AND_OPUS = ["reviewer-on-sonnet", "reviewer-on-opus"];

describe("chooseAutomaticFlavors", () => {
  test("puts the reviewer one tier above the default builders", () => {
    const choice = chooseAutomaticFlavors(
      loadTeam(SONNET_AND_OPUS),
      [],
      [],
      standInDockerAgent(PATCHES),
    );
    expect(choice.flavorNames).toEqual(["reviewer-on-opus"]);
    expect(choice.explanation).toBe(
      "reviewer 'reviewer' runs on opus (builder sonnet, tester sonnet), so the review is independent",
    );
  });

  // The point of choosing after the user's flavors: `--model haiku` moves the builders to Haiku,
  // which would otherwise leave a reviewer chosen for Sonnet builders on the wrong side.
  test("reads the builders' tier after --model has been applied", () => {
    const choice = chooseAutomaticFlavors(
      loadTeam(SONNET_AND_OPUS),
      ["model-haiku"],
      [],
      standInDockerAgent(PATCHES),
    );
    expect(choice.flavorNames).toEqual(["reviewer-on-sonnet"]);
  });

  // --effort only sets reasoning effort; it must not change which tier the reviewer gets.
  test("an effort flavor alone leaves the reviewer one tier above the default builders", () => {
    const choice = chooseAutomaticFlavors(
      loadTeam(SONNET_AND_OPUS),
      ["effort-xhigh"],
      [],
      standInDockerAgent(PATCHES),
    );
    expect(choice.flavorNames).toEqual(["reviewer-on-opus"]);
  });

  // Fable is not offered here, as in issue-team: an Opus builder has nothing above it, so the
  // review comes from below, from a tier that still differs.
  test("reviews an Opus builder from below when Fable is not on offer", () => {
    const choice = chooseAutomaticFlavors(
      loadTeam(SONNET_AND_OPUS),
      ["model-opus"],
      [],
      standInDockerAgent(PATCHES),
    );
    expect(choice.flavorNames).toEqual(["reviewer-on-sonnet"]);
  });

  test("moves a Fable builder's reviewer down to Opus, and an Opus builder's up to Fable when offered", () => {
    const withFable = loadTeam([...SONNET_AND_OPUS, "reviewer-on-fable"]);
    expect(
      chooseAutomaticFlavors(withFable, ["model-fable"], [], standInDockerAgent(PATCHES))
        .flavorNames,
    ).toEqual(["reviewer-on-opus"]);
    expect(
      chooseAutomaticFlavors(withFable, ["model-opus"], [], standInDockerAgent(PATCHES))
        .flavorNames,
    ).toEqual(["reviewer-on-fable"]);
  });

  // Catches the reviewer flavor landing before the user's: docker-agent applies flavors in the
  // order given, and the first read must see --model and --effort alone, in the order given.
  test("asks docker-agent with the user's flavors alone, then with the reviewer flavor after them", () => {
    const calls: string[][] = [];
    chooseAutomaticFlavors(
      loadTeam(SONNET_AND_OPUS),
      ["model-haiku", "effort-xhigh"],
      [],
      standInDockerAgent(PATCHES, { calls }),
    );
    expect(calls.map((call) => call.slice(3).join(" "))).toEqual([
      "--flavor model-haiku --flavor effort-xhigh",
      "--flavor model-haiku --flavor effort-xhigh --flavor reviewer-on-sonnet",
    ]);
  });

  // The guard behind the choice: a flavor that patches the wrong model must not pass for
  // independence. Here reviewer-on-opus is accepted by docker-agent but leaves the reviewer alone.
  test("refuses a flavor that does not actually move the reviewer", () => {
    const team = loadTeam(SONNET_AND_OPUS);
    const choose = () =>
      chooseAutomaticFlavors(
        team,
        [],
        [],
        standInDockerAgent(PATCHES, {
          base: { reviewer: "claude-sonnet-5-5" },
          ignoredFlavors: ["reviewer-on-opus"],
        }),
      );
    expect(choose).toThrow(IndependenceError);
    expect(choose).toThrow("flavor reviewer-on-opus did not make the review independent");
  });

  test("refuses when the team offers no tier different from the builders", () => {
    const team = loadTeam(["reviewer-on-sonnet"]);
    expect(() => chooseAutomaticFlavors(team, [], [], standInDockerAgent(PATCHES))).toThrow(
      "no reviewer tier differs",
    );
  });

  test("refuses a builder whose model has no known tier", () => {
    const team = loadTeam(SONNET_AND_OPUS);
    expect(() =>
      chooseAutomaticFlavors(
        team,
        [],
        [],
        standInDockerAgent(PATCHES, { base: { builder: "gpt-5" } }),
      ),
    ).toThrow("agent 'builder' runs 'gpt-5'");
  });

  // Catches an override sneaking in after `--`: `docker agent debug config` has no --model, so
  // the rule would pass on a config the run then ignores.
  test.each([
    [["--model", "reviewer=pi/claude-sonnet-5-5"], "--model"],
    [["--model=reviewer=pi/claude-sonnet-5-5"], "--model=reviewer=pi/claude-sonnet-5-5"],
    [["--flavor", "low"], "--flavor"],
    [["--flavor=low"], "--flavor=low"],
  ])("refuses %p after '--'", (passthrough, conflicting) => {
    const team = loadTeam(SONNET_AND_OPUS);
    expect(() =>
      chooseAutomaticFlavors(team, [], passthrough, standInDockerAgent(PATCHES)),
    ).toThrow(`${conflicting} after '--' would change the models`);
  });

  test("allows docker-agent flags that do not change a model", () => {
    const team = loadTeam(SONNET_AND_OPUS);
    expect(
      chooseAutomaticFlavors(
        team,
        [],
        ["--safety", "balanced", "--exec"],
        standInDockerAgent(PATCHES),
      ).flavorNames,
    ).toEqual(["reviewer-on-opus"]);
  });

  // A team with no rule must not be asked anything: no docker-agent call, no flavor, no output.
  test("does nothing for a team without an independence rule", () => {
    const withoutRule = MANIFEST_YAML.slice(0, MANIFEST_YAML.indexOf("independence:"));
    const team = loadManifest(
      writeTeamFixture(createTemporaryDirectory(), withoutRule, teamYaml([])),
    );
    const calls: string[][] = [];
    expect(
      chooseAutomaticFlavors(
        team,
        ["model-haiku"],
        ["--model", "x"],
        standInDockerAgent(PATCHES, { calls }),
      ),
    ).toEqual({ flavorNames: [], explanation: undefined });
    expect(calls).toEqual([]);
  });

  test("reports docker-agent's own error when it cannot read the team", () => {
    const team = loadTeam(SONNET_AND_OPUS);
    expect(() =>
      chooseAutomaticFlavors(team, [], [], () => ({
        exitCode: 1,
        standardOutput: "",
        standardError: "no such file: team.yaml",
      })),
    ).toThrow(`docker agent debug config ${join(team.directory, "team.yaml")} failed`);
  });
});
