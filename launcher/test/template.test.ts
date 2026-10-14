import { describe, expect, test } from "bun:test";

import { extractPlaceholderNames, fillTemplate } from "../src/template.ts";

describe("extractPlaceholderNames", () => {
  test("lists each placeholder once, in order of first use", () => {
    expect(extractPlaceholderNames("{repo}-issue-{issue} for {repo}")).toEqual(["repo", "issue"]);
  });

  test("ignores braces that are not lowercase placeholder names", () => {
    // `{ }`, `{Issue}` and `{1}` are literal text in a message, not placeholders.
    expect(extractPlaceholderNames("json { } {Issue} {1} {pr-number}")).toEqual(["pr-number"]);
  });

  test("returns nothing for a template without placeholders", () => {
    expect(extractPlaceholderNames("Close it out.")).toEqual([]);
  });
});

describe("fillTemplate", () => {
  test("replaces every occurrence of every placeholder", () => {
    expect(fillTemplate("{repo}-issue-{issue}, again {issue}", { repo: "app", issue: "12" })).toBe(
      "app-issue-12, again 12",
    );
  });

  test("throws on a placeholder with no value instead of leaving it in the text", () => {
    expect(() => fillTemplate("Work issue #{isue}", { issue: "12" })).toThrow(
      "template placeholder {isue} has no value",
    );
  });

  test("inserts values literally, without re-expanding placeholders inside them", () => {
    expect(fillTemplate("Work on {title}", { title: "{issue}", issue: "99" })).toBe(
      "Work on {issue}",
    );
  });
});
