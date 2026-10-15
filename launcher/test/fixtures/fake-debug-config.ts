// The one call the stand-in `docker` programs answer like the real thing: `docker agent debug
// config`, which the launcher uses to read the models an issue-team agent runs on
// (launcher/src/team-models.ts). Without it, launching issue-team under a stand-in docker would
// fail before reaching the stand-in's own behavior.
//
// The answer reflects the flavors in the arguments the way issue-team's team.yaml defines them:
// `low` puts the builders on Haiku, and `reviewer-on-<tier>` puts the reviewer on that tier.

const BUILDER_MODEL_BY_FLAVOR: Record<string, string> = { low: "claude-haiku-5-5" };
const REVIEWER_MODEL_BY_FLAVOR: Record<string, string> = {
  "reviewer-on-sonnet": "claude-sonnet-5-5",
  "reviewer-on-opus": "claude-opus-4-7",
};

/** True when the arguments are `agent debug config ...`. */
function isDebugConfigCall(dockerArguments: string[]): boolean {
  return (
    dockerArguments[0] === "agent" &&
    dockerArguments[1] === "debug" &&
    dockerArguments[2] === "config"
  );
}

/**
 * Prints the canned resolved config and exits 0 when the arguments are `agent debug config ...`;
 * returns normally for any other call.
 */
export function answerDebugConfigCall(dockerArguments: string[]): void {
  if (!isDebugConfigCall(dockerArguments)) {
    return;
  }
  const flavors = dockerArguments.flatMap((argument, index) =>
    dockerArguments[index - 1] === "--flavor" ? [argument] : [],
  );
  let builderModel = "claude-sonnet-5-5";
  let reviewerModel = "claude-opus-4-7";
  for (const flavor of flavors) {
    builderModel = BUILDER_MODEL_BY_FLAVOR[flavor] ?? builderModel;
    reviewerModel = REVIEWER_MODEL_BY_FLAVOR[flavor] ?? reviewerModel;
  }
  // JSON is valid YAML, which is what the launcher parses.
  console.log(
    JSON.stringify({
      agents: {
        root: { model: "coordinator_model" },
        builder: { model: "builder_model" },
        tester: { model: "tester_model" },
        reviewer: { model: "reviewer_model" },
      },
      models: {
        coordinator_model: { provider: "pi", model: builderModel },
        builder_model: { provider: "pi", model: builderModel },
        tester_model: { provider: "pi", model: builderModel },
        reviewer_model: { provider: "pi", model: reviewerModel },
      },
    }),
  );
  process.exit(0);
}
