import { describe, expect, test } from "bun:test";

import { findUnknownOptionNames, parseArguments } from "../src/arguments.ts";

describe("parseArguments", () => {
  test("splits positionals, options in both spellings, switches and passthrough", () => {
    const parsed = parseArguments([
      "issue-team",
      "work-issue",
      "--issue",
      "12",
      "--effort=low",
      "--print",
      "--",
      "--safety",
      "balanced",
    ]);
    expect(parsed).toEqual({
      positionals: ["issue-team", "work-issue"],
      optionValues: new Map([
        ["issue", "12"],
        ["effort", "low"],
      ]),
      switches: new Set(["print"]),
      passthroughArguments: ["--safety", "balanced"],
    });
  });

  test("passes everything after the first bare -- through untouched, including another --", () => {
    const parsed = parseArguments(["issue-team", "--", "--model", "x", "--", "--print"]);
    expect(parsed.passthroughArguments).toEqual(["--model", "x", "--", "--print"]);
    expect(parsed.switches.has("print")).toBe(false);
  });

  test("keeps an empty value given with = so validation can reject it with the flag's name", () => {
    expect(parseArguments(["--issue="]).optionValues.get("issue")).toBe("");
  });

  test("treats -h as help", () => {
    expect(parseArguments(["-h"]).switches.has("help")).toBe(true);
  });

  test("rejects a short option, pointing at the passthrough separator", () => {
    expect(() => parseArguments(["issue-team", "-a", "reviewer"])).toThrow(
      "unknown option '-a'; docker-agent flags go after '--'",
    );
  });

  test("rejects an option at the end of the line with no value", () => {
    expect(() => parseArguments(["issue-team", "work-issue", "--issue"])).toThrow(
      "--issue needs a value",
    );
  });

  test("rejects an option whose value would be the passthrough separator", () => {
    expect(() => parseArguments(["--issue", "--", "--yolo"])).toThrow("--issue needs a value");
  });

  test("rejects a repeated option instead of silently keeping one value", () => {
    expect(() => parseArguments(["--issue", "1", "--issue=2"])).toThrow(
      "--issue given more than once",
    );
  });

  test("rejects a value on a switch", () => {
    expect(() => parseArguments(["--print=yes"])).toThrow("--print takes no value");
  });
});

describe("findUnknownOptionNames", () => {
  test("accepts launcher options and the entry point's parameters, reports the rest", () => {
    const optionValues = new Map([
      ["project", "."],
      ["base", "origin/main"],
      ["effort", "low"],
      ["issue", "3"],
      ["pr", "4"],
    ]);
    expect(findUnknownOptionNames(optionValues, ["issue"])).toEqual(["pr"]);
  });
});
