// `j5 setup`: checks that this machine can run the teams, installs the skills the teams read,
// and, with --proxy, starts the local Pi proxy that gives docker-agent its Claude models.
//
// Nothing here assumes a git checkout: it works from the package root (the clone, or the
// installed package directory) so the same code serves both. Everything the machine provides
// (commands, home directory, the network) comes in through SetupEnvironment, so tests run the
// real logic against temporary directories and stand-in commands.
//
// The proxy token is a secret. It is never printed, only saved to docker-agent's env file.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { EnvironmentVariables } from "./environment.ts";
import {
  checkProxyImage,
  describeDifferentProxyImage,
  PROXY_DIRECTORY_PARTS,
} from "./proxy-image.ts";
import { copySkill, inspectSkill, listSkillPlacements } from "./skills.ts";

/** The docker-agent release the teams were written and tested against (CI installs the same). */
export const TESTED_DOCKER_AGENT_VERSION = "v1.145.0";

/**
 * The oldest Bun this package is meant for. Equal to the `engines.bun` floor in package.json and to
 * the version CI installs; a test keeps all three together. Older Bun versions may still work, so
 * setup warns instead of failing.
 */
export const MINIMUM_BUN_VERSION = "1.4.2";

const SUCCESS_EXIT_CODE = 0;
const FAILURE_EXIT_CODE = 1;
// What a shell reports for a command it cannot find; used for an executable that is missing.
const COMMAND_NOT_FOUND_EXIT_CODE = 127;

const PROXY_TOKEN_VARIABLE = "PI_PROXY_AUTH_TOKEN";
const PROXY_PORT_VARIABLE = "PI_PROXY_PORT";
const DEFAULT_PROXY_PORT = "4141";
const PROXY_TOKEN_BYTES = 32;
const PROXY_REQUEST_TIMEOUT_MILLISECONDS = 5000;
// docker-agent loads this file on its own, so one token serves Compose and the teams.
const DOCKER_AGENT_ENV_FILE_PARTS = [".config", "cagent", ".env"];
const OWNER_ONLY_FILE_MODE = 0o600;
// Opens Pi's own terminal UI in the proxy image, where `/login` stores the Claude login in the
// proxy's credential volume. Same command the proxy README gives.
const PI_LOGIN_ENTRYPOINT = "node";
const PI_LOGIN_ARGUMENTS = [
  "/app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  "--no-session",
  "--no-tools",
  "--no-extensions",
  "--offline",
];

/** How one line of the report is tagged. */
type LineStatus = "ok" | "changed" | "info" | "warning" | "missing";

export type CommandResult = { exitCode: number; standardOutput: string; standardError: string };

/** What the proxy answered to a request for its model list. */
export type ProxyModelsResult =
  | { kind: "models"; modelIds: string[] }
  | { kind: "refused"; status: number }
  | { kind: "unreachable"; reason: string };

/** Everything setup depends on from the machine, so tests can supply their own. */
export type SetupEnvironment = {
  /** The clone or the installed package directory: where skills/ and containers/ are. */
  packageRoot: string;
  homeDirectory: string;
  platform: NodeJS.Platform;
  environmentVariables: EnvironmentVariables;
  bunVersion: string;
  /** Runs a command and captures its output. An executable that is not found is exit code 127. */
  runCommand: (commandWords: string[]) => CommandResult;
  /** Runs a command with the terminal attached (long or interactive) and returns its exit code. */
  runAttached: (commandWords: string[]) => number;
  fetchProxyModels: (port: string, token: string) => Promise<ProxyModelsResult>;
  generateToken: () => string;
};

/** Choices from the command line. `withLogin` implies `withProxy`. */
export type SetupOptions = {
  /** Report only; change nothing. */
  checkOnly: boolean;
  withProxy: boolean;
  withLogin: boolean;
};

const proxyModelsResponseSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

/**
 * Runs a command and captures its output. An executable that is not found is exit code 127 rather
 * than a throw, so callers can treat "no such tool" like any other failed check.
 */
export function runCapturedCommand(commandWords: string[]): CommandResult {
  try {
    const completedProcess = Bun.spawnSync(commandWords, { stdout: "pipe", stderr: "pipe" });
    return {
      exitCode: completedProcess.exitCode,
      standardOutput: completedProcess.stdout.toString().trim(),
      standardError: completedProcess.stderr.toString().trim(),
    };
  } catch (error) {
    return {
      exitCode: COMMAND_NOT_FOUND_EXIT_CODE,
      standardOutput: "",
      standardError: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The real machine: real commands, the real home directory, a real HTTP request. */
export function createSetupEnvironment(
  packageRoot: string,
  homeDirectory: string,
): SetupEnvironment {
  return {
    packageRoot,
    homeDirectory,
    platform: process.platform,
    environmentVariables: process.env,
    bunVersion: Bun.version,
    runCommand: runCapturedCommand,
    runAttached: (commandWords) => {
      try {
        return Bun.spawnSync(commandWords, {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        }).exitCode;
      } catch {
        return COMMAND_NOT_FOUND_EXIT_CODE;
      }
    },
    fetchProxyModels: async (port, token) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(PROXY_REQUEST_TIMEOUT_MILLISECONDS),
        });
        if (!response.ok) {
          return { kind: "refused", status: response.status };
        }
        const parsed = proxyModelsResponseSchema.safeParse(await response.json());
        return parsed.success
          ? { kind: "models", modelIds: parsed.data.data.map((model) => model.id) }
          : { kind: "unreachable", reason: "the answer was not a model list" };
      } catch (error) {
        return {
          kind: "unreachable",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    generateToken: () => randomBytes(PROXY_TOKEN_BYTES).toString("hex"),
  };
}

type Reporter = {
  line: (status: LineStatus, text: string) => void;
  /** True once any line was `missing`, which makes the run exit non-zero. */
  hasFailed: () => boolean;
};

function createReporter(emit: (line: string) => void): Reporter {
  let failed = false;
  return {
    line: (status, text) => {
      if (status === "missing") {
        failed = true;
      }
      emit(`${status.padEnd(8)} ${text}`);
    },
    hasFailed: () => failed,
  };
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

/** True when `version` ("1.3.13") is lower than `minimum` ("1.4.2"), comparing numeric parts. */
function isOlderVersion(version: string, minimum: string): boolean {
  const versionParts = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const minimumParts = minimum.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(versionParts.length, minimumParts.length); index += 1) {
    const difference = (versionParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (difference !== 0) {
      return difference < 0;
    }
  }
  return false;
}

function checkCommandLineTools(
  environment: SetupEnvironment,
  options: SetupOptions,
  reporter: Reporter,
): void {
  if (isOlderVersion(environment.bunVersion, MINIMUM_BUN_VERSION)) {
    reporter.line(
      "warning",
      `bun ${environment.bunVersion} is older than ${MINIMUM_BUN_VERSION}, which number-5 requires (package.json engines) and is tested with; upgrade with: bun upgrade`,
    );
  } else {
    reporter.line("ok", `bun ${environment.bunVersion}`);
  }

  const gitVersion = environment.runCommand(["git", "--version"]);
  if (gitVersion.exitCode === SUCCESS_EXIT_CODE) {
    reporter.line("ok", firstLine(gitVersion.standardOutput));
  } else {
    reporter.line("missing", "git is not installed (https://git-scm.com/downloads)");
  }

  const ghVersion = environment.runCommand(["gh", "--version"]);
  if (ghVersion.exitCode !== SUCCESS_EXIT_CODE) {
    reporter.line(
      "missing",
      "gh is not installed (https://cli.github.com); issue-team and pr-reviewer need it",
    );
  } else {
    reporter.line("ok", firstLine(ghVersion.standardOutput));
    const ghLogin = environment.runCommand(["gh", "auth", "status"]);
    if (ghLogin.exitCode !== SUCCESS_EXIT_CODE) {
      reporter.line("warning", "gh is not logged in; run: gh auth login");
    }
  }

  const dockerVersion = environment.runCommand(["docker", "--version"]);
  if (dockerVersion.exitCode !== SUCCESS_EXIT_CODE) {
    reporter.line("missing", "docker is not installed (https://docs.docker.com/get-docker/)");
    return;
  }
  reporter.line("ok", firstLine(dockerVersion.standardOutput));

  const daemonVersion = environment.runCommand([
    "docker",
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  if (daemonVersion.exitCode !== SUCCESS_EXIT_CODE) {
    // The teams only need the docker CLI plugin; the proxy needs a daemon this user can reach.
    // "Permission denied" is a different problem from a stopped daemon with a different fix: on
    // Linux the user is usually just not in the docker group.
    const daemonProblem = daemonVersion.standardError.toLowerCase().includes("permission denied")
      ? "Docker is running but this user may not use it (permission denied on the Docker socket). On Linux run: sudo usermod -aG docker $USER, then log out and back in, or run: newgrp docker. Members of that group have root-equivalent access to the machine"
      : "the Docker daemon is not running or cannot be reached (the proxy needs it)";
    reporter.line(options.withProxy ? "missing" : "warning", daemonProblem);
  }

  const dockerAgentVersion = environment.runCommand(["docker", "agent", "version"]);
  if (dockerAgentVersion.exitCode !== SUCCESS_EXIT_CODE) {
    reporter.line(
      "missing",
      "the docker-agent plugin is not installed (https://docs.docker.com/ai/docker-agent/)",
    );
    return;
  }
  const installedVersion = /v\d+\.\d+\.\d+\S*/.exec(
    firstLine(dockerAgentVersion.standardOutput),
  )?.[0];
  if (installedVersion === TESTED_DOCKER_AGENT_VERSION) {
    reporter.line("ok", `docker-agent ${installedVersion}`);
  } else {
    reporter.line(
      "warning",
      `docker-agent ${installedVersion ?? "(unknown version)"}; the teams were tested with ${TESTED_DOCKER_AGENT_VERSION}, so flags may differ`,
    );
  }
}

function setUpSkills(
  environment: SetupEnvironment,
  options: SetupOptions,
  reporter: Reporter,
): void {
  const placements = listSkillPlacements(environment.packageRoot, environment.homeDirectory);
  if (placements.length === 0) {
    reporter.line("info", "no skills in this package");
    return;
  }
  for (const placement of placements) {
    const state = inspectSkill(placement);
    const target = `skill ${placement.skillName} (${placement.installedPath})`;
    if (state === "current") {
      reporter.line("ok", `${target} is up to date`);
    } else if (state === "foreign") {
      // Not ours: never replaced, even in a real run.
      reporter.line(
        "warning",
        `${target} exists and was not installed by number-5 (no marker file); left alone`,
      );
    } else if (options.checkOnly) {
      reporter.line(
        "warning",
        `${target} is ${state}; run j5 setup to ${state === "missing" ? "install" : "refresh"} it`,
      );
    } else {
      copySkill(placement);
      reporter.line("changed", `${state === "missing" ? "installed" : "refreshed"} ${target}`);
    }
  }
}

function dockerAgentEnvFilePath(environment: SetupEnvironment): string {
  return join(environment.homeDirectory, ...DOCKER_AGENT_ENV_FILE_PARTS);
}

function unquote(value: string): string {
  const quote = value[0];
  return (quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)
    ? value.slice(1, -1)
    : value;
}

/** Reads one `NAME=value` entry (optionally `export NAME=value`) from an env file, if present. */
function readEnvFileValue(envFilePath: string, variableName: string): string | undefined {
  if (!existsSync(envFilePath)) {
    return undefined;
  }
  for (const line of readFileSync(envFilePath, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] === variableName) {
      const value = unquote(match[2] ?? "");
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}

/** Where the proxy token is found: the shell environment wins, as it does for Compose. */
type ProxyToken = { value: string; source: "environment" | "env-file" };

function findProxyToken(environment: SetupEnvironment): ProxyToken | undefined {
  const fromEnvironment = environment.environmentVariables[PROXY_TOKEN_VARIABLE];
  if (fromEnvironment !== undefined && fromEnvironment !== "") {
    return { value: fromEnvironment, source: "environment" };
  }
  const fromFile = readEnvFileValue(dockerAgentEnvFilePath(environment), PROXY_TOKEN_VARIABLE);
  return fromFile === undefined ? undefined : { value: fromFile, source: "env-file" };
}

/** Appends a new token to docker-agent's env file, keeping every other entry, owner-only. */
function saveNewProxyToken(environment: SetupEnvironment): ProxyToken {
  const envFilePath = dockerAgentEnvFilePath(environment);
  const value = environment.generateToken();
  const existingText = existsSync(envFilePath) ? readFileSync(envFilePath, "utf8") : "";
  const separator = existingText === "" || existingText.endsWith("\n") ? "" : "\n";
  mkdirSync(dirname(envFilePath), { recursive: true });
  writeFileSync(envFilePath, `${existingText}${separator}${PROXY_TOKEN_VARIABLE}=${value}\n`);
  if (environment.platform !== "win32") {
    chmodSync(envFilePath, OWNER_ONLY_FILE_MODE);
  }
  return { value, source: "env-file" };
}

function composeCommandWords(environment: SetupEnvironment, token: ProxyToken): string[] {
  const composeFilePath = join(environment.packageRoot, ...PROXY_DIRECTORY_PARTS, "compose.yaml");
  // A token from the shell reaches Compose through the inherited environment; one from the env
  // file has to be handed over, because Compose does not read docker-agent's file by itself.
  const envFileWords =
    token.source === "env-file" ? ["--env-file", dockerAgentEnvFilePath(environment)] : [];
  return ["docker", "compose", ...envFileWords, "-f", composeFilePath];
}

function proxyPort(environment: SetupEnvironment): string {
  return (
    environment.environmentVariables[PROXY_PORT_VARIABLE] ??
    readEnvFileValue(dockerAgentEnvFilePath(environment), PROXY_PORT_VARIABLE) ??
    DEFAULT_PROXY_PORT
  );
}

/** Asks the running proxy for its models and reports what that says about its state. */
async function reportProxyModels(
  environment: SetupEnvironment,
  token: ProxyToken,
  reporter: Reporter,
): Promise<boolean> {
  const port = proxyPort(environment);
  const result = await environment.fetchProxyModels(port, token.value);
  if (result.kind === "models" && result.modelIds.length > 0) {
    reporter.line("ok", `proxy on port ${port} serves ${result.modelIds.length} models`);
    return true;
  }
  if (result.kind === "models") {
    reporter.line(
      "warning",
      `proxy on port ${port} is up but has no Claude login yet; run: j5 setup --login`,
    );
  } else if (result.kind === "refused") {
    reporter.line(
      "warning",
      `proxy on port ${port} refused the token (HTTP ${result.status}): it was started with a different PI_PROXY_AUTH_TOKEN; restart it with the token j5 uses`,
    );
  } else {
    reporter.line("warning", `proxy not reachable on port ${port}: ${result.reason}`);
  }
  return false;
}

/**
 * Says whether the running proxy container is on the image this j5 pins. Silent when the check
 * cannot tell (no container, no Docker), because the model report above already says the proxy is
 * down and a machine without the proxy has nothing to be told.
 */
function reportProxyImage(environment: SetupEnvironment, reporter: Reporter): void {
  const status = checkProxyImage(environment.packageRoot, environment.runCommand);
  if (status.kind === "current") {
    reporter.line("ok", `proxy image ${status.image} is the one this j5 expects`);
  } else if (status.kind === "different") {
    reporter.line("warning", describeDifferentProxyImage(status));
  }
}

async function setUpProxy(
  environment: SetupEnvironment,
  options: SetupOptions,
  reporter: Reporter,
  emit: (line: string) => void,
): Promise<void> {
  let token = findProxyToken(environment);
  if (token === undefined) {
    if (options.checkOnly) {
      reporter.line(
        "warning",
        `no ${PROXY_TOKEN_VARIABLE} yet; run j5 setup --proxy to create one`,
      );
      return;
    }
    token = saveNewProxyToken(environment);
    reporter.line(
      "changed",
      `created ${PROXY_TOKEN_VARIABLE} in ${dockerAgentEnvFilePath(environment)} (owner-only; docker-agent and Compose both read it)`,
    );
  } else {
    reporter.line(
      "ok",
      `${PROXY_TOKEN_VARIABLE} found in ${token.source === "environment" ? "the environment" : dockerAgentEnvFilePath(environment)}`,
    );
  }

  if (options.checkOnly) {
    await reportProxyModels(environment, token, reporter);
    reportProxyImage(environment, reporter);
    return;
  }

  const composeWords = composeCommandWords(environment, token);
  emit(
    "info     starting the proxy. This restarts it if its image or settings changed, which interrupts a run in progress. If you are not logged in to ghcr.io the image pull is denied and Compose builds the same image locally, which takes longer",
  );
  const startExitCode = environment.runAttached([...composeWords, "up", "-d", "--wait"]);
  if (startExitCode !== SUCCESS_EXIT_CODE) {
    reporter.line("missing", `the proxy did not start (docker compose exited ${startExitCode})`);
    return;
  }
  reporter.line("changed", "proxy is running and healthy");
  reportProxyImage(environment, reporter);

  let hasModels = await reportProxyModels(environment, token, reporter);
  if (!hasModels && options.withLogin) {
    emit(
      "info     opening Pi: type /login, choose Anthropic, then 'Browser login' ('Copy code login' on a machine without a browser). Open the printed link in your browser; exit Pi when it says you are logged in. Use your own account, never a shared one.",
    );
    const loginExitCode = environment.runAttached([
      ...composeWords,
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      PI_LOGIN_ENTRYPOINT,
      "proxy",
      ...PI_LOGIN_ARGUMENTS,
    ]);
    if (loginExitCode !== SUCCESS_EXIT_CODE) {
      reporter.line("warning", `Pi exited ${loginExitCode}; the login may not have finished`);
    }
    hasModels = await reportProxyModels(environment, token, reporter);
  }
}

/**
 * Runs setup, emitting each report line as it happens (so attached commands interleave
 * correctly), and returns the process exit code: non-zero when something required is missing
 * or the proxy would not start.
 */
export async function runSetup(
  options: SetupOptions,
  environment: SetupEnvironment,
  emit: (line: string) => void,
): Promise<number> {
  const reporter = createReporter(emit);
  checkCommandLineTools(environment, options, reporter);
  setUpSkills(environment, options, reporter);
  if (options.withProxy) {
    await setUpProxy(environment, options, reporter, emit);
  }
  if (reporter.hasFailed()) {
    emit("setup found problems above (lines starting with 'missing').");
    return FAILURE_EXIT_CODE;
  }
  emit(options.checkOnly ? "check done; nothing was changed." : "setup done.");
  return SUCCESS_EXIT_CODE;
}
