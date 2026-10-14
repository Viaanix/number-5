// Shared plumbing for every team's helpers (workflows/<team>/helpers/*.ts). It lives
// here rather than in one team so no team imports from another. Each helper is a
// Bun script started by a two-line launcher in the team's bin/: an extensionless sh
// file for Linux and macOS, and a .cmd for Windows. That is what lets docker-agent's
// script tools call them by bare name from bash, zsh, PowerShell or cmd.exe alike.
// The j5 launcher itself does not use this file.

const SUCCESS_EXIT_CODE = 0;

/** Exit code for a missing or malformed argument, matching the bash helpers. */
export const USAGE_EXIT_CODE = 2;

/** Thrown for bad arguments; the helper exits with USAGE_EXIT_CODE. */
export class HelperUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelperUsageError";
  }
}

/**
 * Resolves a command name through PATH the way a shell would, including Windows
 * PATHEXT (.exe, .cmd, ...), so the first match on PATH runs even when it is a .cmd
 * wrapper. Falls back to the bare name, letting the spawn report it as missing.
 */
function resolveExecutable(commandWords: string[]): string[] {
  const [commandName, ...commandArguments] = commandWords;
  if (commandName === undefined) {
    throw new Error("no command given");
  }
  return [Bun.which(commandName) ?? commandName, ...commandArguments];
}

/**
 * Runs a command in the current directory and returns its stdout unchanged.
 * @throws Error with the command's stderr when it exits non-zero.
 */
export function runAndCapture(commandWords: string[]): string {
  const completedProcess = Bun.spawnSync(resolveExecutable(commandWords), {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (completedProcess.exitCode !== SUCCESS_EXIT_CODE) {
    throw new Error(
      `${commandWords.join(" ")} failed (exit ${completedProcess.exitCode}): ${completedProcess.stderr.toString().trim()}`,
    );
  }
  return completedProcess.stdout.toString();
}

/** Runs a command and reports only whether it exited 0. */
export function succeeds(commandWords: string[]): boolean {
  return (
    Bun.spawnSync(resolveExecutable(commandWords), { stdout: "ignore", stderr: "ignore" })
      .exitCode === SUCCESS_EXIT_CODE
  );
}

/**
 * Returns a tool argument: the first command-line argument when given, else the
 * environment variable of the same name. docker-agent's script tools pass their
 * arguments as environment variables (script_shell.go), and the team.yaml `cmd:`
 * lines name the helper bare, so no shell has to expand `$pr` / `$env:pr` / `%pr%`.
 * Empty values count as absent.
 */
export function readToolArgument(argumentName: string): string | undefined {
  const fromCommandLine = Bun.argv[2];
  if (fromCommandLine !== undefined && fromCommandLine !== "") {
    return fromCommandLine;
  }
  const fromEnvironment = process.env[argumentName];
  return fromEnvironment === undefined || fromEnvironment === "" ? undefined : fromEnvironment;
}

/** Runs a helper's main function and exits with its status, printing errors to stderr. */
export function runHelper(helperName: string, main: () => void): never {
  try {
    main();
    process.exit(SUCCESS_EXIT_CODE);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${helperName}: ${message}`);
    process.exit(error instanceof HelperUsageError ? USAGE_EXIT_CODE : 1);
  }
}
