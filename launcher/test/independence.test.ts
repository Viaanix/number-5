// Tests for the independence rule's pure logic (launcher/src/independence.ts) and the manifest
// block that declares it. The launch-time step that applies it is in reviewer-flavor.test.ts.

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  chooseReviewer,
  chooseReviewerTier,
  classifyModel,
  findIndependenceProblems,
  IndependenceError,
  type ModelTier,
  reviewerFlavorTier,
} from "../src/independence.ts";
import { loadManifest } from "../src/manifest.ts";
import {
  buildTeamYaml,
  createTemporaryDirectory,
  removeTemporaryDirectories,
  writeTeamFixture,
} from "./fixtures.ts";

afterAll(removeTemporaryDirectories);

describe("classifyModel", () => {
  // Catches a tier being read from the wrong word, or only from ids that put it in one place:
  // Claude ids have used `claude-<tier>-<version>` and `claude-<version>-<tier>-<date>`.
  test.each([
    ["claude-sonnet-5-5", "sonnet"],
    ["claude-haiku-5-5", "haiku"],
    ["claude-opus-4-7", "opus"],
    ["claude-fable-5-1", "fable"],
    ["claude-3-5-sonnet-20241022", "sonnet"],
    ["claude-haiku-4-5-20251001", "haiku"],
    // A provider prefix is not part of the tier.
    ["anthropic/claude-opus-4-7", "opus"],
    ["pi/claude-sonnet-5-5", "sonnet"],
    ["CLAUDE-OPUS-4-7", "opus"],
  ] as Array<[string, ModelTier]>)("%s is %p", (modelId, expectedTier) => {
    expect(classifyModel(modelId)).toBe(expectedTier);
  });

  // Catches a model with no known tier passing as "independent of everything": the rule must
  // refuse it rather than guess.
  test.each(["gpt-5", "gemini-2.5-pro", "claude-mythos-5-1", "sonnet-or-opus", ""])(
    "%p has no tier",
    (modelId) => {
      expect(classifyModel(modelId)).toBeUndefined();
    },
  );
});

describe("reviewerFlavorTier", () => {
  test("reads the tier from reviewer-on-<tier> and nothing else", () => {
    expect(reviewerFlavorTier("reviewer-on-opus")).toBe("opus");
    expect(reviewerFlavorTier("reviewer-on-fable")).toBe("fable");
    expect(reviewerFlavorTier("reviewer-on-gpt")).toBeUndefined();
    expect(reviewerFlavorTier("low")).toBeUndefined();
    expect(reviewerFlavorTier("opus")).toBeUndefined();
  });
});

describe("chooseReviewerTier", () => {
  const ALL_TIERS: ModelTier[] = ["haiku", "sonnet", "opus", "fable"];

  // The ladder the user asked for: one tier above the builder, and one below only from the top.
  test.each([
    [["haiku"], "sonnet"],
    [["sonnet"], "opus"],
    [["opus"], "fable"],
    // "then down to opus if fable": the top tier cannot go up.
    [["fable"], "opus"],
  ] as Array<[ModelTier[], ModelTier]>)(
    "builders on %p are reviewed on %p when every tier is offered",
    (reviewedTiers, expectedTier) => {
      expect(chooseReviewerTier(reviewedTiers, ALL_TIERS)).toBe(expectedTier);
    },
  );

  // Catches the reviewer being picked from tiers the team cannot actually run: here the proxy
  // serves no Fable, so an Opus builder has nothing above it and must be reviewed from below.
  test("falls back to the nearest tier below when nothing above is offered", () => {
    expect(chooseReviewerTier(["opus"], ["sonnet", "opus"])).toBe("sonnet");
    expect(chooseReviewerTier(["opus"], ["haiku", "sonnet", "opus"])).toBe("sonnet");
  });

  test("goes one step up from the highest builder tier, not the lowest", () => {
    expect(chooseReviewerTier(["haiku", "sonnet"], ALL_TIERS)).toBe("opus");
  });

  test("uses a tier between builders that straddle it", () => {
    expect(chooseReviewerTier(["haiku", "opus"], ["haiku", "sonnet", "opus"])).toBe("sonnet");
  });

  test("never returns a tier the builders are on", () => {
    expect(chooseReviewerTier(["sonnet"], ["sonnet"])).toBeUndefined();
    expect(chooseReviewerTier(["sonnet", "opus"], ["sonnet", "opus"])).toBeUndefined();
  });

  test("returns nothing when the team offers no tier at all, or reviews nothing", () => {
    expect(chooseReviewerTier(["sonnet"], [])).toBeUndefined();
    expect(chooseReviewerTier([], ALL_TIERS)).toBeUndefined();
  });
});

describe("findIndependenceProblems", () => {
  const RULE = { reviewer: "reviewer", reviews: ["builder", "tester"] };

  test("accepts a reviewer on a different tier", () => {
    expect(
      findIndependenceProblems(RULE, {
        builder: "claude-sonnet-5-5",
        tester: "claude-sonnet-5-5",
        reviewer: "claude-opus-4-7",
      }),
    ).toEqual([]);
  });

  // The failure the rule exists for, and the one issue-team had until now: every role on Sonnet.
  test("names the agents the reviewer shares a class with", () => {
    const problems = findIndependenceProblems(RULE, {
      builder: "claude-sonnet-5-5",
      tester: "claude-opus-4-7",
      reviewer: "claude-sonnet-4-6",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("reviewer 'reviewer' runs claude-sonnet-4-6");
    expect(problems[0]).toContain("builder (claude-sonnet-5-5)");
    // Same tier, different version: still the same class.
    expect(problems[0]).not.toContain("tester");
  });

  test("refuses to judge a model it cannot classify, naming it", () => {
    const problems = findIndependenceProblems(RULE, {
      builder: "gpt-5",
      tester: "claude-sonnet-5-5",
      reviewer: "claude-opus-4-7",
    });
    expect(problems.join("\n")).toContain("agent 'builder' runs 'gpt-5'");
  });

  test("reports an agent that has no model", () => {
    const problems = findIndependenceProblems(RULE, {
      builder: "claude-sonnet-5-5",
      reviewer: "claude-opus-4-7",
    });
    expect(problems.join("\n")).toContain("agent 'tester' has no model");
  });
});

describe("chooseReviewer", () => {
  const RULE = { reviewer: "reviewer", reviews: ["builder", "tester"] };

  test("names the flavor to add and says why", () => {
    const choice = chooseReviewer(RULE, ["sonnet", "opus"], {
      builder: "claude-haiku-5-5",
      tester: "claude-haiku-5-5",
      reviewer: "claude-opus-4-7",
    });
    expect(choice.flavorName).toBe("reviewer-on-sonnet");
    expect(choice.explanation).toBe(
      "reviewer 'reviewer' runs on sonnet (builder haiku, tester haiku), so the review is independent",
    );
  });

  test("fails with what the team offers when no tier is independent", () => {
    expect(() =>
      chooseReviewer(RULE, ["sonnet"], {
        builder: "claude-sonnet-5-5",
        tester: "claude-sonnet-5-5",
        reviewer: "claude-sonnet-5-5",
      }),
    ).toThrow(IndependenceError);
    expect(() =>
      chooseReviewer(RULE, ["sonnet"], {
        builder: "claude-sonnet-5-5",
        tester: "claude-sonnet-5-5",
        reviewer: "claude-sonnet-5-5",
      }),
    ).toThrow("the team offers sonnet");
  });

  test("fails on an unclassifiable builder instead of guessing", () => {
    expect(() =>
      chooseReviewer(RULE, ["sonnet", "opus"], {
        builder: "gpt-5",
        tester: "claude-sonnet-5-5",
        reviewer: "claude-opus-4-7",
      }),
    ).toThrow("names none of the tiers");
  });
});

describe("the independence block of workflow.yaml", () => {
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

  function loadWith(independenceYaml: string) {
    const manifestPath = writeTeamFixture(
      createTemporaryDirectory(),
      `${MANIFEST_HEAD}${independenceYaml}`,
      buildTeamYaml([]),
    );
    return loadManifest(join(manifestPath));
  }

  test("is optional, and read when present", () => {
    expect(loadWith("").independence).toBeUndefined();
    expect(
      loadWith("independence:\n  reviewer: reviewer\n  reviews: [builder, tester]\n").independence,
    ).toEqual({ reviewer: "reviewer", reviews: ["builder", "tester"] });
  });

  // Catches a reviewer being declared independent of itself, which no tier choice can satisfy.
  test("rejects a reviewer that reviews itself", () => {
    expect(() => loadWith("independence:\n  reviewer: reviewer\n  reviews: [reviewer]\n")).toThrow(
      "'reviewer' cannot review its own work",
    );
  });

  test("rejects an agent listed twice, an empty list and a misspelled key", () => {
    expect(() =>
      loadWith("independence:\n  reviewer: reviewer\n  reviews: [builder, builder]\n"),
    ).toThrow("an agent is listed twice");
    expect(() => loadWith("independence:\n  reviewer: reviewer\n  reviews: []\n")).toThrow();
    expect(() => loadWith("independence:\n  reviewer: reviewer\n  review: [builder]\n")).toThrow();
  });
});
