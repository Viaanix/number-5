import { describe, expect, test } from "bun:test";

import { describeInvalidChoice, describeInvalidParameterValue } from "../src/parameters.ts";

const ISSUE_PARAMETER = { type: "integer", label: "Issue number" } as const;
const TITLE_PARAMETER = { type: "string", label: "Title" } as const;

describe("describeInvalidParameterValue", () => {
  test.each(["1", "42", "1000000"])("accepts the positive integer %p", (rawValue) => {
    expect(describeInvalidParameterValue("issue", ISSUE_PARAMETER, rawValue)).toBeUndefined();
  });

  test.each([
    ["0", "zero is never an issue number"],
    ["-3", "negative"],
    ["012", "leading zero"],
    ["12abc", "trailing text"],
    ["1.5", "decimal"],
    ["#12", "issue reference instead of a number"],
  ])("rejects %p for an integer parameter (%s)", (rawValue) => {
    expect(describeInvalidParameterValue("issue", ISSUE_PARAMETER, rawValue)).toBe(
      `--issue must be a positive integer, got '${rawValue}'`,
    );
  });

  test.each(["", "   "])("rejects the blank value %p for any type", (rawValue) => {
    expect(describeInvalidParameterValue("title", TITLE_PARAMETER, rawValue)).toBe(
      "--title needs a value",
    );
  });

  test("accepts free text for a string parameter", () => {
    expect(describeInvalidParameterValue("title", TITLE_PARAMETER, "fix #12")).toBeUndefined();
  });
});

describe("describeInvalidChoice", () => {
  test("accepts no choice, meaning team.yaml as written, even when the team offers none", () => {
    expect(describeInvalidChoice("effort", undefined, [])).toBeUndefined();
    expect(describeInvalidChoice("model", undefined, [])).toBeUndefined();
  });

  test("accepts an offered value", () => {
    expect(describeInvalidChoice("effort", "low", ["low", "max"])).toBeUndefined();
    expect(describeInvalidChoice("model", "haiku", ["haiku", "opus"])).toBeUndefined();
  });

  // Catches a typo running at the team's default: docker-agent would ignore the unknown flavor.
  test("rejects a misspelled value and lists the valid ones, in the option's own words", () => {
    expect(describeInvalidChoice("effort", "lwo", ["low", "max"])).toBe(
      "--effort 'lwo' is not an effort of this team; choose one of: low, max",
    );
    expect(describeInvalidChoice("model", "hiaku", ["haiku", "opus"])).toBe(
      "--model 'hiaku' is not a model tier of this team; choose one of: haiku, opus",
    );
  });

  // The two options are independent: an effort the team offers is no model tier.
  test("does not take a value offered for the other option", () => {
    expect(describeInvalidChoice("model", "low", ["haiku", "opus"])).toContain("not a model tier");
  });

  test("rejects any value for a team that offers none, and says how to get some", () => {
    expect(describeInvalidChoice("effort", "low", [])).toBe(
      "--effort 'low': this team offers no effort choices (its team.yaml has no effort-* flavors; run bun run flavors)",
    );
  });
});
