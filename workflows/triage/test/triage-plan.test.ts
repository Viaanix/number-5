import { describe, expect, test } from "bun:test";

import {
  buildTriageComment,
  decideRepeat,
  labelsForChild,
  markerVerdict,
  MAX_CHILDREN,
  MAX_CHILD_BODY_CHARACTERS,
  MAX_COMMENT_CHARACTERS,
  parseChildren,
  parseIssueNumber,
  parseVerdict,
  planLabelChange,
  requireCommentText,
  triageMarker,
  VERDICT_LABELS,
  VERDICTS,
} from "../helpers/triage-plan.ts";

/** Assembled at run time so this file is not itself a secret-scan hit. */
const GITHUB_TOKEN_SAMPLE = ["gh", "p", "_", "A".repeat(36)].join("");
const marker = (verdict: "ready" | "needs-info") => buildTriageComment(verdict, "x", []);

function children(count: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      title: `Part ${index + 1}`,
      body: `Do part ${index + 1}.`,
    })),
  );
}

describe("parseIssueNumber and parseVerdict", () => {
  // Catches a model-supplied value reaching `gh` as something other than one issue number.
  test.each(["", "0", "-3", "12abc", "1 2", "012"])("rejects the issue number '%s'", (value) => {
    expect(() => parseIssueNumber(value)).toThrow("positive issue number");
  });

  test("accepts a positive issue number", () => {
    expect(parseIssueNumber("12")).toBe(12);
  });

  // Catches a verdict outside the four reaching label code, where it would become a made-up label.
  test("accepts exactly the four verdicts and rejects anything else", () => {
    for (const verdict of VERDICTS) {
      expect(parseVerdict(verdict)).toBe(verdict);
    }
    expect(() => parseVerdict("close")).toThrow("verdict must be one of");
    expect(() => parseVerdict(undefined)).toThrow("verdict must be one of");
  });

  // Catches a label outside the j5/ namespace: it could collide with a repository's own label.
  test("every verdict label lives under j5/", () => {
    for (const verdict of VERDICTS) {
      expect(VERDICT_LABELS[verdict].name).toBe(`j5/${verdict}`);
    }
  });
});

describe("requireCommentText", () => {
  test("trims and returns the comment", () => {
    expect(requireCommentText("  Needs a repro.\n")).toBe("Needs a repro.");
  });

  test("refuses an empty comment", () => {
    expect(() => requireCommentText("   ")).toThrow("comment must be the triage comment text");
  });

  // Catches an oversize comment: it would exceed the environment variable it travels in.
  test("refuses a comment over the limit", () => {
    expect(() => requireCommentText("x".repeat(MAX_COMMENT_CHARACTERS + 1))).toThrow(
      "the limit is",
    );
  });

  // Catches a leaked secret from the issue being quoted into a comment others can read.
  test("refuses a comment that contains a credential shape", () => {
    expect(() => requireCommentText(`The reporter pasted ${GITHUB_TOKEN_SAMPLE} here`)).toThrow(
      "appears to contain a GitHub token",
    );
  });
});

describe("parseChildren", () => {
  // Catches a stray children argument on a non-split verdict creating issues anyway.
  test("refuses children for any verdict but split", () => {
    expect(() => parseChildren(children(2), "ready")).toThrow("only for the split verdict");
    expect(parseChildren(undefined, "ready")).toEqual([]);
    expect(parseChildren("  ", "needs-info")).toEqual([]);
  });

  test("a split needs children", () => {
    expect(() => parseChildren(undefined, "split")).toThrow("needs children");
  });

  // Catches a one-child "split" (a rename) and an unbounded one (a flood of issues).
  test("a split needs between two and the maximum number of children", () => {
    expect(() => parseChildren(children(1), "split")).toThrow("needs 2 to 8 children");
    expect(parseChildren(children(2), "split")).toHaveLength(2);
    expect(parseChildren(children(MAX_CHILDREN), "split")).toHaveLength(MAX_CHILDREN);
    expect(() => parseChildren(children(MAX_CHILDREN + 1), "split")).toThrow("needs 2 to 8");
  });

  test("returns trimmed titles and bodies in order", () => {
    const parsed = parseChildren(
      JSON.stringify([
        { title: "  First  ", body: " Body one \n" },
        { title: "Second", body: "Body two" },
      ]),
      "split",
    );
    expect(parsed).toEqual([
      { title: "First", body: "Body one" },
      { title: "Second", body: "Body two" },
    ]);
  });

  test("refuses text that is not a JSON array of title and body objects", () => {
    expect(() => parseChildren("not json", "split")).toThrow("not valid JSON");
    expect(() => parseChildren('{"title":"a"}', "split")).toThrow("array of");
    expect(() =>
      parseChildren('[{"title":"a","body":"b","extra":1},{"title":"c","body":"d"}]', "split"),
    ).toThrow("array of");
  });

  test("refuses a multi-line title, an empty body and an oversize body", () => {
    expect(() =>
      parseChildren('[{"title":"a\\nb","body":"x"},{"title":"c","body":"d"}]', "split"),
    ).toThrow("title must be one line");
    expect(() =>
      parseChildren('[{"title":"a","body":" "},{"title":"c","body":"d"}]', "split"),
    ).toThrow("empty body");
    expect(() =>
      parseChildren(
        JSON.stringify([
          { title: "a", body: "x".repeat(MAX_CHILD_BODY_CHARACTERS + 1) },
          { title: "b", body: "d" },
        ]),
        "split",
      ),
    ).toThrow("the limit is 3000");
  });

  // Catches creating two issues with one title, which a reader cannot tell apart.
  test("refuses duplicate titles, ignoring case", () => {
    expect(() =>
      parseChildren(
        '[{"title":"Add parser","body":"a"},{"title":"add PARSER","body":"b"}]',
        "split",
      ),
    ).toThrow("two children are titled");
  });

  test("refuses a credential shape in a child", () => {
    expect(() =>
      parseChildren(
        JSON.stringify([
          { title: "a", body: `token ${GITHUB_TOKEN_SAMPLE}` },
          { title: "b", body: "d" },
        ]),
        "split",
      ),
    ).toThrow("appears to contain a GitHub token");
  });
});

describe("planLabelChange", () => {
  // Catches an issue ending up with two verdicts (for example ready and needs-info at once).
  test("adds the verdict's label and removes every other verdict label", () => {
    expect(planLabelChange(["bug", "j5/needs-info", "j5/split"], "ready")).toEqual({
      add: ["j5/ready"],
      remove: ["j5/needs-info", "j5/split"],
    });
  });

  // Catches this team removing a label that is not its own.
  test("never touches labels that are not verdict labels", () => {
    const plan = planLabelChange(["bug", "j5/custom", "area/login"], "needs-decision");
    expect(plan).toEqual({ add: ["j5/needs-decision"], remove: [] });
  });

  test("adds nothing when the issue already has the label", () => {
    expect(planLabelChange(["j5/ready"], "ready")).toEqual({ add: [], remove: [] });
  });
});

describe("labelsForChild", () => {
  // Catches a child inheriting its parent's verdict (j5/split), or losing its type label.
  test("keeps the parent's own labels, drops j5/ verdicts and marks the child ready", () => {
    expect(labelsForChild(["bug", "area/login", "j5/split"])).toEqual([
      "bug",
      "area/login",
      "j5/ready",
    ]);
  });
});

describe("the triage comment and repeat detection", () => {
  test("a comment carries a marker that names its verdict", () => {
    const comment = buildTriageComment("needs-info", "Please add the version.", []);
    expect(comment).toStartWith(triageMarker("needs-info"));
    expect(markerVerdict(comment)).toBe("needs-info");
    expect(comment).toContain("Please add the version.");
    expect(comment).toContain("Nothing was built or run.");
  });

  test("a split comment lists the sub-issues it created", () => {
    const comment = buildTriageComment("split", "Too big.", [
      { number: 101, title: "Parse" },
      { number: 102, title: "Render" },
    ]);
    expect(comment).toContain("- #101 Parse\n- #102 Render");
  });

  test("a comment without a marker has no verdict", () => {
    expect(markerVerdict("looks good to me")).toBeUndefined();
  });

  // Catches a re-run of a queue posting the same triage comment twice.
  test("skips when the last comment is this verdict's triage comment and the label is there", () => {
    expect(
      decideRepeat(
        { labelNames: ["j5/ready"], commentBodies: ["hi", marker("ready")], subIssueCount: 0 },
        "ready",
      ).kind,
    ).toBe("skip");
  });

  // Catches triage going silent after the reporter answered the questions.
  test("applies again when someone commented after the last triage comment", () => {
    expect(
      decideRepeat(
        {
          labelNames: ["j5/needs-info"],
          commentBodies: [marker("needs-info"), "here is the version"],
          subIssueCount: 0,
        },
        "needs-info",
      ).kind,
    ).toBe("apply");
  });

  test("applies when the verdict changed or the label was removed", () => {
    const issue = {
      labelNames: ["j5/needs-info"],
      commentBodies: [marker("needs-info")],
      subIssueCount: 0,
    };
    expect(decideRepeat(issue, "ready").kind).toBe("apply");
    expect(decideRepeat({ ...issue, labelNames: [] }, "needs-info").kind).toBe("apply");
  });

  // Catches a second split creating a second set of children for the same issue.
  test("refuses to split an issue that already has sub-issues", () => {
    expect(
      decideRepeat({ labelNames: [], commentBodies: [], subIssueCount: 2 }, "split").kind,
    ).toBe("refuse");
    expect(
      decideRepeat({ labelNames: [], commentBodies: [], subIssueCount: 2 }, "ready").kind,
    ).toBe("apply");
  });
});
