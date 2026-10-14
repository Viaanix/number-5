// Validation for values the user supplies for manifest parameters and the effort flag.
// Each function returns an error message, or undefined when the value is acceptable,
// so the same check serves both command-line flags and interactive prompts.

import type { ParameterDefinition } from "./manifest.ts";

// Issue and PR numbers: digits only, no sign, no leading zero.
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

/** Returns why the raw value is not valid for the parameter, or undefined when it is. */
export function describeInvalidParameterValue(
  parameterName: string,
  parameterDefinition: ParameterDefinition,
  rawValue: string,
): string | undefined {
  if (rawValue.trim() === "") {
    return `--${parameterName} needs a value`;
  }
  if (parameterDefinition.type === "integer" && !POSITIVE_INTEGER_PATTERN.test(rawValue)) {
    return `--${parameterName} must be a positive integer, got '${rawValue}'`;
  }
  return undefined;
}

/**
 * Returns why the effort is not one of the team's flavors, or undefined when it is.
 * An undefined effort means "the team's defaults" and is always valid.
 */
export function describeInvalidEffort(
  effort: string | undefined,
  flavorNames: string[],
): string | undefined {
  if (effort === undefined || flavorNames.includes(effort)) {
    return undefined;
  }
  if (flavorNames.length === 0) {
    return `--effort '${effort}': this team defines no flavors in its team.yaml`;
  }
  return `--effort '${effort}' is not a flavor of this team; choose one of: ${flavorNames.join(", ")}`;
}
