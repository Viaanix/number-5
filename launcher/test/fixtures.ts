// Real temporary directories and git repositories for launcher tests. Nothing here
// mocks git: the git helpers are tested against repositories built the same way a
// user's clone is (a bare origin, cloned, with origin/HEAD set by the clone).

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { readPathValue, withPathValue } from "../src/environment.ts";

const TEMPORARY_DIRECTORY_PREFIX = "j5-test-";

/** Default branch of fixture repositories; deliberately not "master" or the git default. */
export const FIXTURE_DEFAULT_BRANCH = "trunk";

/** A second remote branch in fixture repositories, for base-branch tests. */
export const FIXTURE_FEATURE_BRANCH = "feature/login";

const createdDirectories: string[] = [];

/** Creates an empty temporary directory, removed by removeTemporaryDirectories. */
export function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), TEMPORARY_DIRECTORY_PREFIX));
  createdDirectories.push(directory);
  return directory;
}

/** Removes every directory made by createTemporaryDirectory; call from afterAll. */
export function removeTemporaryDirectories(): void {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Runs git in a directory and fails the test with git's stderr when it errors.
 * Commits use a fixed identity so tests do not depend on the user's git config.
 */
export function runGit(workingDirectory: string, gitArguments: string[]): string {
  const completedProcess = Bun.spawnSync(
    ["git", "-c", "user.name=j5 test", "-c", "user.email=j5-test@example.invalid", ...gitArguments],
    { cwd: workingDirectory, stdout: "pipe", stderr: "pipe" },
  );
  if (completedProcess.exitCode !== 0) {
    throw new Error(
      `git ${gitArguments.join(" ")} failed in ${workingDirectory}: ${completedProcess.stderr.toString()}`,
    );
  }
  return completedProcess.stdout.toString().trim();
}

/** A clone whose origin is a local bare repository. */
export type FixtureProject = {
  /** The clone's top-level directory, named `repositoryName`. */
  projectRoot: string;
  /** The bare repository the clone's origin points at. */
  originPath: string;
};

/**
 * Builds a bare origin with FIXTURE_DEFAULT_BRANCH and FIXTURE_FEATURE_BRANCH, and a
 * clone of it named repositoryName. The clone has origin/HEAD → origin/trunk.
 */
export function createFixtureProject(repositoryName: string): FixtureProject {
  const parentDirectory = createTemporaryDirectory();
  const originPath = join(parentDirectory, `${repositoryName}.git`);
  runGit(parentDirectory, ["init", "--quiet", "--bare", "-b", FIXTURE_DEFAULT_BRANCH, originPath]);

  const seedDirectory = join(parentDirectory, "seed");
  runGit(parentDirectory, ["init", "--quiet", "-b", FIXTURE_DEFAULT_BRANCH, seedDirectory]);
  runGit(seedDirectory, ["commit", "--quiet", "--allow-empty", "-m", "initial commit"]);
  runGit(seedDirectory, ["push", "--quiet", originPath, FIXTURE_DEFAULT_BRANCH]);
  runGit(seedDirectory, [
    "push",
    "--quiet",
    originPath,
    `HEAD:refs/heads/${FIXTURE_FEATURE_BRANCH}`,
  ]);

  const projectRoot = join(parentDirectory, repositoryName);
  runGit(parentDirectory, ["clone", "--quiet", originPath, projectRoot]);
  return { projectRoot, originPath };
}

/**
 * Writes a team directory: workflow.yaml and team.yaml with the given contents.
 * Returns the path of workflow.yaml.
 */
export function writeTeamFixture(
  teamDirectory: string,
  manifestYaml: string,
  teamYaml: string,
): string {
  mkdirSync(teamDirectory, { recursive: true });
  const manifestPath = join(teamDirectory, "workflow.yaml");
  writeFileSync(manifestPath, manifestYaml);
  writeFileSync(join(teamDirectory, "team.yaml"), teamYaml);
  return manifestPath;
}

/** A minimal team.yaml with a `root` agent and the given flavor names. */
export function buildTeamYaml(flavorNames: string[]): string {
  const lines = ["agents:", "  root:", "    model: anthropic/claude-sonnet-5"];
  if (flavorNames.length > 0) {
    lines.push("flavors:");
    for (const flavorName of flavorNames) {
      lines.push(`  ${flavorName}:`, "    agents:", "      root:", "        description: patched");
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Puts a fake command on disk that runs a Bun script: an extensionless sh launcher
 * for Linux and macOS and a .cmd launcher that Windows finds through PATHEXT, the
 * same pair the team helpers in workflows/issue-team/bin use. Prepend the directory to PATH.
 */
export function writeFakeCommand(directory: string, commandName: string, scriptPath: string): void {
  const posixLauncherPath = join(directory, commandName);
  writeFileSync(posixLauncherPath, `#!/bin/sh\nexec bun "${scriptPath}" "$@"\n`);
  chmodSync(posixLauncherPath, 0o755);
  writeFileSync(join(directory, `${commandName}.cmd`), `@bun "${scriptPath}" %*\r\n`);
}

/** What a team helper printed and how it exited. */
export type HelperResult = { exitCode: number; standardOutput: string; standardError: string };

/** Runs a team helper's Bun script directly: `bun <scriptPath> <helperArguments>`. */
export function runHelperScriptFile(
  scriptPath: string,
  helperArguments: string[],
  workingDirectory: string,
  extraEnvironment: Record<string, string> = {},
): HelperResult {
  const completedProcess = Bun.spawnSync(["bun", scriptPath, ...helperArguments], {
    cwd: workingDirectory,
    stdin: "ignore",
    env: { ...process.env, ...extraEnvironment },
  });
  return {
    exitCode: completedProcess.exitCode,
    standardOutput: completedProcess.stdout.toString(),
    standardError: completedProcess.stderr.toString(),
  };
}

/**
 * The shells docker-agent v1.145.0 runs script tools with: $SHELL -c on Unix
 * (sh here, the strictest), PowerShell -Command or cmd.exe /C on Windows. Each
 * call names the helper bare, with arguments only in the environment.
 */
export const DOCKER_AGENT_SHELLS: Array<{ shellName: string; commandPrefix: string[] }> =
  process.platform === "win32"
    ? [
        { shellName: "pwsh", commandPrefix: ["pwsh", "-NoProfile", "-NonInteractive", "-Command"] },
        { shellName: "cmd", commandPrefix: ["cmd.exe", "/d", "/c"] },
      ]
    : [{ shellName: "sh", commandPrefix: ["sh", "-c"] }];

/**
 * Runs a command line through one of DOCKER_AGENT_SHELLS with a team's bin/ first
 * on PATH, the way a docker-agent script tool calls a helper by bare name.
 * Windows line endings in stdout are normalized to "\n".
 */
export function runThroughDockerAgentShell(
  commandPrefix: string[],
  teamBinDirectory: string,
  command: string,
  workingDirectory: string,
  extraEnvironment: Record<string, string> = {},
): HelperResult {
  const environment = withPathValue(
    { ...process.env, ...extraEnvironment },
    `${teamBinDirectory}${delimiter}${readPathValue(process.env)}`,
  );
  const completedProcess = Bun.spawnSync([...commandPrefix, command], {
    cwd: workingDirectory,
    stdin: "ignore",
    env: environment,
  });
  return {
    exitCode: completedProcess.exitCode,
    standardOutput: completedProcess.stdout.toString().replaceAll("\r\n", "\n"),
    standardError: completedProcess.stderr.toString(),
  };
}
