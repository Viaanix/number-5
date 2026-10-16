// Tests for reading the models of a team from docker-agent's merged config
// (launcher/src/team-models.ts). The command runner is supplied by the test, with output in the
// shape `docker agent debug config` prints.

import { describe, expect, test } from "bun:test";

import { type DockerAgentResult, resolveAgentModels } from "../src/team-models.ts";

const TEAM_CONFIG = "/teams/sample/team.yaml";

function succeedWith(standardOutput: string): DockerAgentResult {
  return { exitCode: 0, standardOutput, standardError: "" };
}

const NAMED_MODELS_CONFIG = `
agents:
  root:
    model: coordinator_model
    description: the coordinator
  builder:
    model: builder_model
  reviewer:
    model: anthropic/claude-opus-4-7
  helper:
    description: an agent with no model of its own
models:
  coordinator_model:
    provider: pi
    model: claude-sonnet-5-5
  builder_model:
    provider: pi
    model: claude-haiku-5-5
    provider_opts:
      extra_body:
        reasoning_effort: high
`;

describe("resolveAgentModels", () => {
  // Catches reading the agent's `model:` reference as the model: `builder_model` names nothing
  // about a tier, and the real one is on the named model's own `model:` line.
  test("follows a named model to its model id, and uses an inline reference as written", () => {
    const models = resolveAgentModels(TEAM_CONFIG, [], () => succeedWith(NAMED_MODELS_CONFIG));
    expect(models).toEqual({
      root: "claude-sonnet-5-5",
      builder: "claude-haiku-5-5",
      reviewer: "anthropic/claude-opus-4-7",
    });
  });

  test("leaves out an agent that has no model", () => {
    const models = resolveAgentModels(TEAM_CONFIG, [], () => succeedWith(NAMED_MODELS_CONFIG));
    expect("helper" in models).toBe(false);
  });

  // Catches the flavors reaching docker-agent in the wrong order or not at all: it applies
  // them in the order given, and the reviewer's tier flavor must come after the effort.
  test("passes the team file, then each flavor as --flavor, in order", () => {
    const seen: string[][] = [];
    resolveAgentModels(TEAM_CONFIG, ["low", "reviewer-on-sonnet"], (dockerAgentArguments) => {
      seen.push(dockerAgentArguments);
      return succeedWith(NAMED_MODELS_CONFIG);
    });
    expect(seen).toEqual([
      ["debug", "config", TEAM_CONFIG, "--flavor", "low", "--flavor", "reviewer-on-sonnet"],
    ]);
  });

  // Catches docker-agent's complaint being swallowed: the caller must see why the team's config
  // could not be read, not a vague "no models".
  test("fails with docker-agent's own output when it rejects the config", () => {
    expect(() =>
      resolveAgentModels(TEAM_CONFIG, [], () => ({
        exitCode: 1,
        standardOutput: "",
        standardError: "unknown field 'agent' (did you mean 'agents'?)",
      })),
    ).toThrow("unknown field 'agent'");
  });

  test("fails on output that is not a resolved config", () => {
    expect(() => resolveAgentModels(TEAM_CONFIG, [], () => succeedWith("models: {}\n"))).toThrow(
      "unexpected output",
    );
  });
});
