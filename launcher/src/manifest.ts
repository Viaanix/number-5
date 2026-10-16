// A team directory becomes launchable by adding a workflow.yaml manifest next to its
// team.yaml. The manifest says which agent each entry point starts, which parameters
// the user must supply, how the git worktree is prepared, and the first message.
// docker-agent itself knows nothing about this file; only the launcher reads it.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import { LAUNCHER_SWITCH_NAMES, LAUNCHER_VALUE_OPTION_NAMES } from "./arguments.ts";
import { extractPlaceholderNames } from "./template.ts";

/** File name the launcher looks for in each team directory under workflows/. */
export const MANIFEST_FILE_NAME = "workflow.yaml";

/** Placeholder every template may use: the basename of the project's git toplevel. */
export const BUILT_IN_REPOSITORY_PLACEHOLDER = "repo";

/**
 * Placeholders only a queue preamble may use: the item's 1-based place in the queue,
 * the queue's length, and the fix-round limit as words ("at most 3 fix rounds").
 */
export const QUEUE_PLACEHOLDERS = {
  position: "position",
  count: "count",
  roundLimit: "round_limit",
} as const;
const QUEUE_PLACEHOLDER_NAMES: string[] = Object.values(QUEUE_PLACEHOLDERS);

// Parameter names become `--<name>` command-line flags, so they are kept to
// lowercase words joined by hyphens.
const PARAMETER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

// Flags the launcher owns; a manifest parameter with one of these names would be
// unreachable from the command line.
const RESERVED_PARAMETER_NAMES: string[] = [
  BUILT_IN_REPOSITORY_PLACEHOLDER,
  ...QUEUE_PLACEHOLDER_NAMES,
  ...LAUNCHER_VALUE_OPTION_NAMES,
  ...LAUNCHER_SWITCH_NAMES,
];

const parameterSchema = z.strictObject({
  type: z.enum(["integer", "string"]),
  label: z.string().min(1),
});

const worktreeSchema = z.discriminatedUnion("mode", [
  // Run in the project checkout itself; edits land on whatever branch is checked out.
  z.strictObject({ mode: z.literal("none") }),
  // A fresh worktree named from a template, branched from a base ref the user picks
  // (default: the remote default branch).
  z.strictObject({ mode: z.literal("new"), name: z.string().min(1) }),
  // PR worktrees normally track its branch; read-only workflows can request a detached snapshot.
  z.strictObject({
    mode: z.literal("pr"),
    pull_request_parameter: z.string().min(1),
    detached: z.boolean().optional(),
  }),
]);

// An entry point that can also run over a queue: once per value of one integer
// parameter, unattended. The preamble goes before the message for every item and
// tells the agent what changes when nobody is there to answer.
const queueSchema = z.strictObject({
  parameter: z.string().min(1),
  preamble: z.string().min(1),
});

const entryPointSchema = z.strictObject({
  description: z.string().min(1),
  agent: z.string().min(1),
  parameters: z.record(z.string(), parameterSchema).default({}),
  worktree: worktreeSchema,
  message: z.string().min(1),
  queue: queueSchema.optional(),
});

// Which agent reviews the work of which others. j5 then keeps the reviewer's model tier different
// from theirs (launcher/src/independence.ts), choosing it from the team's `reviewer-on-<tier>`
// flavors. The agents are named in team.yaml.
const independenceSchema = z.strictObject({
  reviewer: z.string().min(1),
  reviews: z.array(z.string().min(1)).min(1),
});

// Which of the team's named models --model and --effort change. The standard flavors that do it
// are generated into team.yaml from workflows/flavors.yaml (launcher/src/flavor-catalog.ts).
const flavorsSchema = z.strictObject({
  models: z.array(z.string().min(1)).min(1),
});

const manifestSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  team: z.string().min(1),
  path: z.array(z.string().min(1)).default([]),
  entrypoints: z.record(z.string(), entryPointSchema),
  independence: independenceSchema.optional(),
  flavors: flavorsSchema.optional(),
});

/** One user-supplied value an entry point needs, such as an issue number. */
export type ParameterDefinition = z.infer<typeof parameterSchema>;

/** How the launcher prepares the git checkout the agent runs in. */
export type WorktreeDefinition = z.infer<typeof worktreeSchema>;

/** How an entry point runs over a queue of values. */
export type QueueDefinition = z.infer<typeof queueSchema>;

/** Which agent must not share a model class with the agents whose work it reviews. */
export type IndependenceRule = z.infer<typeof independenceSchema>;

/** The named models --model and --effort change, from the manifest's `flavors:` block. */
export type FlavorsDefinition = z.infer<typeof flavorsSchema>;

/** One way of starting a team: an agent, its parameters, worktree mode and first message. */
export type EntryPointDefinition = z.infer<typeof entryPointSchema>;

/** A parsed and cross-checked workflow.yaml, with paths resolved against its directory. */
export type WorkflowManifest = z.infer<typeof manifestSchema> & {
  /** Absolute path of the directory holding workflow.yaml. */
  directory: string;
  /** Absolute path of the docker-agent team configuration. */
  teamConfigPath: string;
  /** Absolute paths prepended to PATH for the docker-agent process. */
  pathDirectories: string[];
};

/**
 * Checks the rules a schema cannot express: parameter names, template placeholders,
 * and the PR parameter reference. Returns one message per problem; empty means valid.
 */
export function findManifestProblems(manifest: z.infer<typeof manifestSchema>): string[] {
  const problems: string[] = [];
  if (manifest.independence !== undefined) {
    const { reviewer, reviews } = manifest.independence;
    if (reviews.includes(reviewer)) {
      problems.push(`independence: '${reviewer}' cannot review its own work`);
    }
    if (new Set(reviews).size !== reviews.length) {
      problems.push("independence.reviews: an agent is listed twice");
    }
  }
  if (
    manifest.flavors !== undefined &&
    new Set(manifest.flavors.models).size !== manifest.flavors.models.length
  ) {
    problems.push("flavors.models: a model is listed twice");
  }
  for (const [entryPointName, entryPoint] of Object.entries(manifest.entrypoints)) {
    const where = `entrypoints.${entryPointName}`;
    const declaredParameterNames = Object.keys(entryPoint.parameters);

    for (const parameterName of declaredParameterNames) {
      if (!PARAMETER_NAME_PATTERN.test(parameterName)) {
        problems.push(
          `${where}.parameters.${parameterName}: name must match ${PARAMETER_NAME_PATTERN}`,
        );
      }
      if (RESERVED_PARAMETER_NAMES.includes(parameterName)) {
        problems.push(`${where}.parameters.${parameterName}: name is reserved by the launcher`);
      }
    }

    const allowedPlaceholders = [BUILT_IN_REPOSITORY_PLACEHOLDER, ...declaredParameterNames];
    const templates: Array<[string, string]> = [["message", entryPoint.message]];
    if (entryPoint.worktree.mode === "new") {
      templates.push(["worktree.name", entryPoint.worktree.name]);
    }
    for (const [templateField, template] of templates) {
      for (const placeholderName of extractPlaceholderNames(template)) {
        if (!allowedPlaceholders.includes(placeholderName)) {
          problems.push(`${where}.${templateField}: unknown placeholder {${placeholderName}}`);
        }
      }
    }

    if (entryPoint.queue !== undefined) {
      const queueParameter = entryPoint.parameters[entryPoint.queue.parameter];
      if (queueParameter === undefined) {
        problems.push(
          `${where}.queue.parameter: '${entryPoint.queue.parameter}' is not a declared parameter`,
        );
      } else if (queueParameter.type !== "integer") {
        problems.push(
          `${where}.queue.parameter: '${entryPoint.queue.parameter}' must be an integer parameter`,
        );
      }
      const allowedInPreamble = [...allowedPlaceholders, ...QUEUE_PLACEHOLDER_NAMES];
      for (const placeholderName of extractPlaceholderNames(entryPoint.queue.preamble)) {
        if (!allowedInPreamble.includes(placeholderName)) {
          problems.push(`${where}.queue.preamble: unknown placeholder {${placeholderName}}`);
        }
      }
    }

    if (entryPoint.worktree.mode === "pr") {
      const pullRequestParameterName = entryPoint.worktree.pull_request_parameter;
      const pullRequestParameter = entryPoint.parameters[pullRequestParameterName];
      if (pullRequestParameter === undefined) {
        problems.push(
          `${where}.worktree.pull_request_parameter: '${pullRequestParameterName}' is not a declared parameter`,
        );
      } else if (pullRequestParameter.type !== "integer") {
        problems.push(
          `${where}.worktree.pull_request_parameter: '${pullRequestParameterName}' must be an integer parameter`,
        );
      }
    }
  }
  return problems;
}

/**
 * Reads, validates and resolves the workflow.yaml at the given path.
 * @throws Error naming the file and every problem found, when the manifest is invalid.
 */
export function loadManifest(manifestPath: string): WorkflowManifest {
  const absoluteManifestPath = resolve(manifestPath);
  const rawDocument: unknown = Bun.YAML.parse(readFileSync(absoluteManifestPath, "utf8"));
  const parseResult = manifestSchema.safeParse(rawDocument);
  if (!parseResult.success) {
    throw new Error(
      `${absoluteManifestPath}: invalid manifest\n${z.prettifyError(parseResult.error)}`,
    );
  }

  const problems = findManifestProblems(parseResult.data);
  const directory = dirname(absoluteManifestPath);
  const teamConfigPath = join(directory, parseResult.data.team);
  if (!existsSync(teamConfigPath)) {
    problems.push(`team: ${teamConfigPath} does not exist`);
  }
  if (problems.length > 0) {
    throw new Error(`${absoluteManifestPath}: invalid manifest\n  ${problems.join("\n  ")}`);
  }

  return {
    ...parseResult.data,
    directory,
    teamConfigPath,
    pathDirectories: parseResult.data.path.map((relativeDirectory) =>
      join(directory, relativeDirectory),
    ),
  };
}
