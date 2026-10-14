import { describe, expect, test } from "bun:test";

import { findPathVariableName, readPathValue, withPathValue } from "../src/environment.ts";

describe("findPathVariableName", () => {
  test("finds the Windows spelling", () => {
    expect(findPathVariableName({ Path: "C:\\Windows", HOME: "x" })).toBe("Path");
  });

  test("defaults to PATH when no spelling exists", () => {
    expect(findPathVariableName({ HOME: "x" })).toBe("PATH");
  });
});

describe("readPathValue", () => {
  test("reads PATH under the Windows spelling", () => {
    expect(readPathValue({ Path: "C:\\Windows" })).toBe("C:\\Windows");
  });

  test("is empty when PATH is absent", () => {
    expect(readPathValue({})).toBe("");
  });
});

describe("withPathValue", () => {
  test("replaces Path under its own spelling instead of adding a second PATH", () => {
    expect(
      withPathValue(
        { Path: "C:\\Windows", USERPROFILE: "C:\\Users\\me" },
        "C:\\team\\bin;C:\\Windows",
      ),
    ).toEqual({
      Path: "C:\\team\\bin;C:\\Windows",
      USERPROFILE: "C:\\Users\\me",
    });
  });

  test("collapses duplicate spellings into one", () => {
    expect(withPathValue({ PATH: "/a", Path: "/b", path: "/c" }, "/new")).toEqual({ PATH: "/new" });
  });

  test("does not modify the environment it was given", () => {
    const original = { PATH: "/usr/bin" };
    withPathValue(original, "/team/bin:/usr/bin");
    expect(original).toEqual({ PATH: "/usr/bin" });
  });
});
