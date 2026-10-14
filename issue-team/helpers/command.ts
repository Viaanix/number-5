// Shared plumbing for the issue-team helpers (bin/issue-team-*). Each helper is a
// Bun script started by a two-line launcher in bin/: an extensionless sh file for
// Linux and macOS, and a .cmd for Windows. That is what lets docker-agent's script
// tools call them by bare name from bash, zsh, PowerShell or cmd.exe alike.

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
 * Runs a command in the current directory and returns its stdout unchanged.
 * @throws Error with the command's stderr when it exits non-zero.
 */
export function runAndCapture(commandWords: string[]): string {
  const completedProcess = Bun.spawnSync(commandWords, { stdout: "pipe", stderr: "pipe" });
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
    Bun.spawnSync(commandWords, { stdout: "ignore", stderr: "ignore" }).exitCode ===
    SUCCESS_EXIT_CODE
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
