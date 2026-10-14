import { describe, expect, test } from "bun:test";

import { formatBanner } from "../src/banner.ts";

// The narrowest terminal the banner must fit without wrapping.
const NARROW_TERMINAL_COLUMNS = 80;
const TAGLINE = [
  "Number 5 is alive.",
  "Agent teams for any checkout:",
  "issue in, pull request out.",
];

describe("formatBanner", () => {
  const lines = formatBanner().split("\n");

  // Catches a tagline that wraps in an 80-column terminal and breaks the art.
  test("fits an 80-column terminal and leaves no trailing spaces", () => {
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(NARROW_TERMINAL_COLUMNS);
      expect(line).toBe(line.trimEnd());
    }
  });

  // Catches tagline lines starting at different columns when an art line is shorter.
  test("lines the tagline up in one column, in order", () => {
    const taglineColumns = TAGLINE.map((taglineLine) => {
      const line = lines.find((candidate) => candidate.endsWith(taglineLine));
      return line === undefined ? -1 : line.length - taglineLine.length;
    });
    expect(taglineColumns[0]).toBeGreaterThan(0);
    expect(new Set(taglineColumns).size).toBe(1);
    expect(lines.findIndex((line) => line.endsWith(TAGLINE[0] ?? ""))).toBeLessThan(
      lines.findIndex((line) => line.endsWith(TAGLINE[2] ?? "")),
    );
  });
});
