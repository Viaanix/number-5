import { describe, expect, test } from "bun:test";

import { describeInvalidEffort, describeInvalidParameterValue } from "../src/parameters.ts";

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

describe("describeInvalidEffort", () => {
  test("accepts no effort, meaning the team's defaults, even when the team has no flavors", () => {
    expect(describeInvalidEffort(undefined, [])).toBeUndefined();
  });

  test("accepts a declared flavor", () => {
    expect(describeInvalidEffort("low", ["low", "max"])).toBeUndefined();
  });

  test("rejects a misspelled flavor and lists the valid ones", () => {
    expect(describeInvalidEffort("lwo", ["low", "max"])).toBe(
      "--effort 'lwo' is not a flavor of this team; choose one of: low, max",
    );
  });

  test("rejects any effort for a team without flavors", () => {
    expect(describeInvalidEffort("low", [])).toBe(
      "--effort 'low': this team defines no flavors in its team.yaml",
    );
  });
});
