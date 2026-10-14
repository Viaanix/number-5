// Command-line parsing for `daw`.
//
//   daw [<team> [<entrypoint>]] [--project PATH] [--base REF] [--effort FLAVOR]
//       [--<parameter> VALUE]... [--print] [--help] [-- <docker agent run flags>...]
//
// Hand-rolled instead of node:util parseArgs because the accepted `--<parameter>`
// flags come from the chosen team's manifest, which is only known after the
// positionals are read. Option names are checked against the manifest later, in
// findUnknownOptionNames.

/** Launcher options that take a value. */
export const LAUNCHER_VALUE_OPTION_NAMES = ["project", "base", "effort"] as const;

/** Launcher options that take no value. */
export const LAUNCHER_SWITCH_NAMES = ["print", "help"] as const;

type LauncherSwitchName = (typeof LAUNCHER_SWITCH_NAMES)[number];

const PASSTHROUGH_SEPARATOR = "--";
const LONG_OPTION_PREFIX = "--";

/** The command line split into its parts; option names are not yet validated. */
export type ParsedArguments = {
  positionals: string[];
  /** Every `--name value` / `--name=value` pair, launcher options and parameters alike. */
  optionValues: Map<string, string>;
  switches: Set<LauncherSwitchName>;
  /** Everything after a bare `--`, passed to `docker agent run` unchanged. */
  passthroughArguments: string[];
};

function isLauncherSwitch(optionName: string): optionName is LauncherSwitchName {
  return (LAUNCHER_SWITCH_NAMES as readonly string[]).includes(optionName);
}

/**
 * Splits the command line into positionals, options, switches and passthrough flags.
 * @throws Error on a short option, a repeated option, or an option missing its value.
 */
export function parseArguments(commandLineArguments: string[]): ParsedArguments {
  const parsed: ParsedArguments = {
    positionals: [],
    optionValues: new Map(),
    switches: new Set(),
    passthroughArguments: [],
  };

  let index = 0;
  while (index < commandLineArguments.length) {
    const argument = commandLineArguments[index] ?? "";
    index += 1;

    if (argument === PASSTHROUGH_SEPARATOR) {
      parsed.passthroughArguments = commandLineArguments.slice(index);
      break;
    }
    if (argument === "-h") {
      parsed.switches.add("help");
      continue;
    }
    if (!argument.startsWith(LONG_OPTION_PREFIX)) {
      if (argument.startsWith("-")) {
        throw new Error(
          `unknown option '${argument}'; docker-agent flags go after '--', e.g. daw issue-team work-issue -- --safety balanced`,
        );
      }
      parsed.positionals.push(argument);
      continue;
    }

    const optionText = argument.slice(LONG_OPTION_PREFIX.length);
    const equalsIndex = optionText.indexOf("=");
    const optionName = equalsIndex === -1 ? optionText : optionText.slice(0, equalsIndex);

    if (isLauncherSwitch(optionName)) {
      if (equalsIndex !== -1) {
        throw new Error(`--${optionName} takes no value`);
      }
      parsed.switches.add(optionName);
      continue;
    }

    let optionValue: string | undefined;
    if (equalsIndex !== -1) {
      optionValue = optionText.slice(equalsIndex + 1);
    } else {
      optionValue = commandLineArguments[index];
      index += 1;
    }
    if (optionValue === undefined || optionValue === PASSTHROUGH_SEPARATOR) {
      throw new Error(`--${optionName} needs a value`);
    }
    if (parsed.optionValues.has(optionName)) {
      throw new Error(`--${optionName} given more than once`);
    }
    parsed.optionValues.set(optionName, optionValue);
  }
  return parsed;
}

/**
 * Returns option names that are neither launcher options nor parameters of the entry point.
 */
export function findUnknownOptionNames(
  optionValues: Map<string, string>,
  parameterNames: string[],
): string[] {
  const knownNames: string[] = [...LAUNCHER_VALUE_OPTION_NAMES, ...parameterNames];
  return [...optionValues.keys()].filter((optionName) => !knownNames.includes(optionName));
}
