// Reading and replacing PATH in an environment object on every OS.
//
// On Windows the variable is usually spelled `Path`, and environment names are
// case-insensitive to the OS but not to a plain JavaScript object. Copying
// process.env into an object and then setting `PATH` would leave both `Path` and
// `PATH` in the child's environment, and which one wins is up to the OS. So the
// existing spelling is found and replaced instead.

/** An environment as Bun and Node expose it: values may be undefined. */
export type EnvironmentVariables = Record<string, string | undefined>;

const DEFAULT_PATH_VARIABLE_NAME = "PATH";

/** Returns the name PATH is stored under (e.g. `Path` on Windows), or `PATH` when absent. */
export function findPathVariableName(environment: EnvironmentVariables): string {
  const existingName = Object.keys(environment).find(
    (variableName) => variableName.toUpperCase() === DEFAULT_PATH_VARIABLE_NAME,
  );
  return existingName ?? DEFAULT_PATH_VARIABLE_NAME;
}

/** Returns the value of PATH under whatever spelling it has, or an empty string. */
export function readPathValue(environment: EnvironmentVariables): string {
  return environment[findPathVariableName(environment)] ?? "";
}

/**
 * Returns a copy of the environment whose PATH is the given value, stored under the
 * existing spelling, with any other spellings of PATH removed.
 */
export function withPathValue(
  environment: EnvironmentVariables,
  pathValue: string,
): EnvironmentVariables {
  const pathVariableName = findPathVariableName(environment);
  const copiedEnvironment: EnvironmentVariables = {};
  for (const [variableName, value] of Object.entries(environment)) {
    if (variableName.toUpperCase() !== DEFAULT_PATH_VARIABLE_NAME) {
      copiedEnvironment[variableName] = value;
    }
  }
  copiedEnvironment[pathVariableName] = pathValue;
  return copiedEnvironment;
}
