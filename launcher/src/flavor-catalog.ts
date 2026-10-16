// The standard flavors every team offers, generated from one catalog.
//
// docker-agent has no include or import for flavors: they live in each team.yaml, and its own
// idea of reuse is the same flavor *names* across many files. So the definitions are written once
// here (workflows/flavors.yaml: which model each tier is, which efforts exist) and a script writes
// each team's `flavors:` block from them, between marker comments. A team says which of its
// named models the launch options tune in the `flavors.models` list of its workflow.yaml.
//
// The names are the contract with the launcher:
//   model-<tier>       --model <tier>   puts the tunable models on that tier's model
//   effort-<level>     --effort <level> sets reasoning_effort on the tunable models and the reviewer's
//   reviewer-on-<tier> j5 adds it itself to keep the reviewer off the builders' tier
//                      (launcher/src/independence.ts); never a user choice
//   queue-unattended   j5 adds it itself to every queue run of an entry point whose `queue.approves`
//                      lists tools; it approves them on top of team.yaml's `permissions.allow`
// Model and effort flavors patch different keys, so they combine in either order.

import { readFileSync } from "node:fs";

import { z } from "zod";

import { MODEL_TIERS, REVIEWER_FLAVOR_PREFIX, classifyModel } from "./independence.ts";
import type { ModelTier } from "./independence.ts";
import type { WorkflowManifest } from "./manifest.ts";

export const MODEL_FLAVOR_PREFIX = "model-";
export const EFFORT_FLAVOR_PREFIX = "effort-";
export const QUEUE_FLAVOR_NAME = "queue-unattended";

const BEGIN_MARKER = "# BEGIN GENERATED FLAVORS";
const END_MARKER = "# END GENERATED FLAVORS";
const GENERATED_SECTION_PATTERN =
  /^# BEGIN GENERATED FLAVORS[^\n]*\n[\s\S]*?^# END GENERATED FLAVORS[^\n]*\n?/m;

const tierNameSchema = z.enum(MODEL_TIERS);

const catalogSchema = z.strictObject({
  /** Tier name to the model id that tier means for every team. */
  tiers: z.partialRecord(tierNameSchema, z.string().min(1)),
  /** Reasoning efforts a user may ask for, as the proxy spells them. */
  efforts: z.array(z.string().min(1)).min(1),
});

export type FlavorCatalog = z.infer<typeof catalogSchema>;

/** What a team's workflow.yaml says about tuning: which named models the launch options change. */
export type TeamTuning = {
  /** Named models (keys under `models:` in team.yaml) that --model and --effort change. */
  tunableModels: string[];
  /** The named models of the independence reviewer; they follow --effort, never --model. */
  reviewerModels: string[];
  /**
   * The tools a queue run approves (the union of the entry points' `queue.approves`) and the
   * tools team.yaml already approves. Absent when no entry point approves anything.
   */
  queueApproval?: { approvedTools: string[]; alreadyAllowedTools: string[] };
};

type ModelPatch = { model?: string; provider_opts?: { extra_body: { reasoning_effort: string } } };

/**
 * One flavor: a patch over `models:`, or over `permissions:`. A list in a flavor replaces the
 * base list (gotchas.md), so a permissions flavor carries the whole allow list.
 */
export type FlavorPatch = {
  models?: Record<string, ModelPatch>;
  permissions?: { allow: string[] };
};

/** Reads and checks the catalog: every tier is a known tier and its model id classifies to it. */
export function loadFlavorCatalog(catalogPath: string): FlavorCatalog {
  const parsed = catalogSchema.safeParse(Bun.YAML.parse(readFileSync(catalogPath, "utf8")));
  if (!parsed.success) {
    throw new Error(`${catalogPath}: invalid flavor catalog\n${z.prettifyError(parsed.error)}`);
  }
  const problems: string[] = [];
  for (const [tier, modelId] of Object.entries(parsed.data.tiers)) {
    if (classifyModel(modelId) !== tier) {
      problems.push(`tiers.${tier}: '${modelId}' is not a ${tier} model`);
    }
  }
  if (new Set(parsed.data.efforts).size !== parsed.data.efforts.length) {
    problems.push("efforts: a level is listed twice");
  }
  if (problems.length > 0) {
    throw new Error(`${catalogPath}: invalid flavor catalog\n  ${problems.join("\n  ")}`);
  }
  return parsed.data;
}

function catalogTiers(catalog: FlavorCatalog): Array<[ModelTier, string]> {
  return MODEL_TIERS.flatMap((tier): Array<[ModelTier, string]> => {
    const modelId = catalog.tiers[tier];
    return modelId === undefined ? [] : [[tier, modelId]];
  });
}

function modelsOnTier(modelNames: string[], modelId: string): FlavorPatch {
  return {
    models: Object.fromEntries(modelNames.map((modelName) => [modelName, { model: modelId }])),
  };
}

/**
 * Every flavor a team gets, in file order: its model flavors, its effort flavors, (when it has an
 * independence reviewer) a reviewer flavor per tier, and (when a queue approves tools) the
 * queue flavor.
 */
export function buildFlavors(
  catalog: FlavorCatalog,
  tuning: TeamTuning,
): Record<string, FlavorPatch> {
  const flavors: Record<string, FlavorPatch> = {};
  for (const [tier, modelId] of catalogTiers(catalog)) {
    flavors[`${MODEL_FLAVOR_PREFIX}${tier}`] = modelsOnTier(tuning.tunableModels, modelId);
  }
  const effortModels = [...new Set([...tuning.tunableModels, ...tuning.reviewerModels])];
  for (const level of catalog.efforts) {
    flavors[`${EFFORT_FLAVOR_PREFIX}${level}`] = {
      models: Object.fromEntries(
        effortModels.map((modelName) => [
          modelName,
          { provider_opts: { extra_body: { reasoning_effort: level } } },
        ]),
      ),
    };
  }
  if (tuning.reviewerModels.length > 0) {
    for (const [tier, modelId] of catalogTiers(catalog)) {
      flavors[`${REVIEWER_FLAVOR_PREFIX}${tier}`] = modelsOnTier(tuning.reviewerModels, modelId);
    }
  }
  if (tuning.queueApproval !== undefined) {
    const { approvedTools, alreadyAllowedTools } = tuning.queueApproval;
    flavors[QUEUE_FLAVOR_NAME] = {
      permissions: { allow: [...alreadyAllowedTools, ...approvedTools] },
    };
  }
  return flavors;
}

/** The marker-wrapped YAML text of a flavors block, as it is written into team.yaml. */
export function renderGeneratedSection(flavors: Record<string, FlavorPatch>): string {
  const lines = [
    `${BEGIN_MARKER}: written by \`bun run flavors\` from workflows/flavors.yaml and the`,
    "# `flavors:` block of workflow.yaml. Edit those, not this block.",
    "flavors:",
  ];
  for (const [flavorName, patch] of Object.entries(flavors)) {
    lines.push(`  ${flavorName}:`);
    if (patch.permissions !== undefined) {
      lines.push("    permissions:", "      allow:");
      for (const toolName of patch.permissions.allow) {
        lines.push(`        - ${toolName}`);
      }
    }
    if (patch.models !== undefined) {
      lines.push("    models:");
      for (const [modelName, modelPatch] of Object.entries(patch.models)) {
        lines.push(`      ${modelName}:`);
        if (modelPatch.model !== undefined) {
          lines.push(`        model: ${modelPatch.model}`);
        }
        if (modelPatch.provider_opts !== undefined) {
          lines.push(
            "        provider_opts:",
            "          extra_body:",
            `            reasoning_effort: ${modelPatch.provider_opts.extra_body.reasoning_effort}`,
          );
        }
      }
    }
  }
  lines.push(END_MARKER, "");
  return lines.join("\n");
}

/** Whether team.yaml text has the marker block the generator owns. */
export function hasGeneratedSection(teamYamlText: string): boolean {
  return GENERATED_SECTION_PATTERN.test(teamYamlText);
}

/**
 * team.yaml text with its generated block replaced by the given one.
 * @throws Error when the file has no marker block (add the two marker lines first).
 */
export function replaceGeneratedSection(teamYamlText: string, section: string): string {
  if (!hasGeneratedSection(teamYamlText)) {
    throw new Error(
      `no '${BEGIN_MARKER}' ... '${END_MARKER}' block to replace; add both marker lines at the end of team.yaml`,
    );
  }
  return teamYamlText.replace(GENERATED_SECTION_PATTERN, () => section);
}

const teamDocumentSchema = z.object({
  agents: z.record(z.string(), z.looseObject({ model: z.string().optional() })),
  models: z.record(z.string(), z.unknown()).default({}),
  permissions: z.looseObject({ allow: z.array(z.string()).default([]) }).optional(),
});

/**
 * Works out a team's tuning from its workflow.yaml block and team.yaml: the reviewer's models are
 * those of the independence reviewer agent, and `approvedTools` (what its queues approve) become
 * the queue flavor's additions to team.yaml's own allow list. Returns the problems found instead
 * when the manifest and team.yaml disagree (a tunable name that is no model, a reviewer with no
 * named model, an approved tool that is already approved or has no allow list to extend).
 */
export function resolveTuning(
  tunableModels: string[],
  independenceReviewer: string | undefined,
  teamYamlText: string,
  approvedTools: string[] = [],
): { tuning: TeamTuning; problems: string[] } {
  const parsed = teamDocumentSchema.safeParse(Bun.YAML.parse(teamYamlText));
  const problems: string[] = [];
  if (!parsed.success) {
    return {
      tuning: { tunableModels, reviewerModels: [] },
      problems: [`team.yaml: not a team config\n${z.prettifyError(parsed.error)}`],
    };
  }
  const { agents, models } = parsed.data;
  for (const modelName of tunableModels) {
    if (!(modelName in models)) {
      problems.push(`flavors.models: '${modelName}' is not a model in team.yaml`);
    }
  }
  const reviewerModels: string[] = [];
  if (independenceReviewer !== undefined) {
    const reviewerModelName = agents[independenceReviewer]?.model;
    if (reviewerModelName === undefined || !(reviewerModelName in models)) {
      problems.push(
        `independence.reviewer: agent '${independenceReviewer}' needs a named model under models: in team.yaml`,
      );
    } else if (tunableModels.includes(reviewerModelName)) {
      problems.push(
        `flavors.models: '${reviewerModelName}' is the reviewer's model; --model must not change it (j5 chooses it)`,
      );
    } else {
      reviewerModels.push(reviewerModelName);
    }
  }
  let queueApproval: TeamTuning["queueApproval"];
  if (approvedTools.length > 0) {
    const alreadyAllowedTools = parsed.data.permissions?.allow ?? [];
    if (parsed.data.permissions === undefined) {
      problems.push(
        `queue.approves: team.yaml has no permissions.allow list to extend; without one the queue flavor would approve only ${approvedTools.join(", ")} and ask for every other tool`,
      );
    }
    for (const toolName of approvedTools) {
      if (alreadyAllowedTools.includes(toolName)) {
        problems.push(
          `queue.approves: '${toolName}' is already in permissions.allow, so interactive runs would not ask either; remove it from one of them`,
        );
      }
    }
    queueApproval = { approvedTools, alreadyAllowedTools };
  }
  return {
    tuning: { tunableModels, reviewerModels, ...(queueApproval && { queueApproval }) },
    problems,
  };
}

/** File name of the catalog, directly under workflows/ next to the team directories. */
export const FLAVOR_CATALOG_FILE_NAME = "flavors.yaml";

/** Every tool the team's queue entry points approve for unattended runs, without repeats. */
export function queueApprovedTools(team: WorkflowManifest): string[] {
  return [
    ...new Set(Object.values(team.entrypoints).flatMap((entry) => entry.queue?.approves ?? [])),
  ];
}

/**
 * The generated block a team's team.yaml should hold, from the catalog and its workflow.yaml.
 * A team without a `flavors:` block in workflow.yaml gets none (`section` undefined).
 */
export function planTeamFlavors(
  catalog: FlavorCatalog,
  team: WorkflowManifest,
): { section: string | undefined; problems: string[] } {
  if (team.flavors === undefined) {
    return { section: undefined, problems: [] };
  }
  const approvedTools = queueApprovedTools(team);
  const { tuning, problems } = resolveTuning(
    team.flavors.models,
    team.independence?.reviewer,
    readFileSync(team.teamConfigPath, "utf8"),
    approvedTools,
  );
  if (problems.length > 0) {
    return { section: undefined, problems };
  }
  return { section: renderGeneratedSection(buildFlavors(catalog, tuning)), problems: [] };
}
