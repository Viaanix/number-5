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

/** What each tuning option picks, for its error message. */
const CHOICE_DESCRIPTIONS = { model: "a model tier", effort: "an effort" } as const;

/**
 * Returns why the value is not one the team offers for `--model` or `--effort`, or undefined when
 * it is. An undefined value means "the team's defaults" and is always valid.
 */
export function describeInvalidChoice(
  optionName: keyof typeof CHOICE_DESCRIPTIONS,
  value: string | undefined,
  offeredValues: string[],
): string | undefined {
  if (value === undefined || offeredValues.includes(value)) {
    return undefined;
  }
  if (offeredValues.length === 0) {
    return `--${optionName} '${value}': this team offers no ${optionName} choices (its team.yaml has no ${optionName}-* flavors; run bun run flavors)`;
  }
  return `--${optionName} '${value}' is not ${CHOICE_DESCRIPTIONS[optionName]} of this team; choose one of: ${offeredValues.join(", ")}`;
}
