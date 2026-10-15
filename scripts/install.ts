// Installs the `j5` launcher for the current user, on Linux, macOS and Windows:
//   1. a link to this repository in the home directory (default ~/number-5):
//      a symlink on Linux and macOS, a directory junction on Windows (no admin rights
//      needed). The alias goes through it, so moving the clone only needs a re-run;
//   2. a `j5` alias (bash, zsh) or function (PowerShell) in the shell's startup file,
//      inside marker lines so re-running replaces it instead of adding a second copy;
//   3. this repository's skills (skills/<name>) copied to ~/.agents/skills/<name>, where
//      docker-agent finds them. Copied, not linked: docker-agent skips symlinked skill
//      directories. Re-running refreshes copies this installer made (marked with
//      INSTALLED_SKILL_MARKER_FILE) and never touches a skill directory it did not make;
//   4. the launcher's bun dependencies, when node_modules is missing.
//
// Usage: bun scripts/install.ts [--link PATH] [--alias NAME] [--shell bash|zsh|powershell]
//                               [--profile FILE] [--dry-run] [--uninstall]

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { quoteForPosixShell, quoteForPowerShell } from "#launcher/shell-quote.ts";

/** Marker lines around the installed block. Unchanged from the bash installer, so
 * blocks it wrote are found and replaced. */
export const BLOCK_BEGIN_MARKER = "# >>> number-5 launcher >>>";
export const BLOCK_END_MARKER = "# <<< number-5 launcher <<<";

const DEFAULT_LINK_NAME = "number-5";
const DEFAULT_ALIAS_NAME = "j5";
// A word every supported shell accepts as an alias or function name.
const ALIAS_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const LAUNCHER_ENTRY_RELATIVE_PATH = join("launcher", "src", "cli.ts");
const SUPPORTED_SHELLS = ["bash", "zsh", "powershell"] as const;

// Where docker-agent looks for skills in the home directory (pkg/skills/local.go).
const INSTALLED_SKILLS_RELATIVE_DIRECTORY = join(".agents", "skills");
const SKILLS_SOURCE_DIRECTORY_NAME = "skills";
/** Written into each skill copy; only directories holding it are replaced or removed. */
export const INSTALLED_SKILL_MARKER_FILE = ".installed-by-number-5";

/** A shell whose startup file the installer knows how to write. */
export type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

/** Everything the installer depends on from the machine, so tests can supply their own. */
export type InstallerEnvironment = {
  platform: NodeJS.Platform;
  homeDirectory: string;
  /** The user's login shell path from $SHELL; undefined on Windows or when unset. */
  loginShellPath: string | undefined;
  /** Returns PowerShell's $PROFILE path, or undefined when no PowerShell is installed. */
  findPowerShellProfilePath: () => string | undefined;
  /** Installs bun dependencies in the repository; only called when node_modules is missing. */
  installDependencies: (repositoryRoot: string) => void;
};

/** Choices from the command line. */
export type InstallerOptions = {
  repositoryRoot: string;
  linkPath: string | undefined;
  aliasName: string;
  shell: SupportedShell | undefined;
  profilePath: string | undefined;
  dryRun: boolean;
  uninstall: boolean;
};

/** A mistake in the options or a state the installer refuses to change. */
export class InstallerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallerError";
  }
}

function isSupportedShell(name: string): name is SupportedShell {
  return (SUPPORTED_SHELLS as readonly string[]).includes(name);
}

/** Picks the shell to configure: --shell, else PowerShell on Windows, else $SHELL. */
export function chooseShell(
  requestedShell: SupportedShell | undefined,
  environment: InstallerEnvironment,
): SupportedShell {
  if (requestedShell !== undefined) {
    return requestedShell;
  }
  if (environment.platform === "win32") {
    return "powershell";
  }
  const loginShellName = basename(environment.loginShellPath ?? "");
  if (isSupportedShell(loginShellName)) {
    return loginShellName;
  }
  throw new InstallerError(
    `cannot tell which shell to configure from SHELL='${environment.loginShellPath ?? ""}'; pass --shell bash, zsh or powershell`,
  );
}

/**
 * Picks the startup file that receives the block:
 * - zsh: ~/.zshrc
 * - bash on macOS: ~/.bash_profile (Terminal opens login shells, which skip ~/.bashrc)
 * - bash elsewhere: ~/.bash_aliases when ~/.bashrc sources it (Debian/Ubuntu), else ~/.bashrc
 * - PowerShell: its $PROFILE
 */
export function chooseProfilePath(
  shell: SupportedShell,
  environment: InstallerEnvironment,
): string {
  const home = environment.homeDirectory;
  if (shell === "zsh") {
    return join(home, ".zshrc");
  }
  if (shell === "powershell") {
    const profilePath = environment.findPowerShellProfilePath();
    if (profilePath === undefined) {
      throw new InstallerError("no PowerShell found to ask for $PROFILE; pass --profile <file>");
    }
    return profilePath;
  }
  if (environment.platform === "darwin") {
    return join(home, ".bash_profile");
  }
  const bashrcPath = join(home, ".bashrc");
  const bashrcSourcesAliases =
    existsSync(bashrcPath) && readFileSync(bashrcPath, "utf8").includes(".bash_aliases");
  return bashrcSourcesAliases ? join(home, ".bash_aliases") : bashrcPath;
}

/**
 * The lines between the markers. bash and zsh get an alias to bin/j5 through the link;
 * PowerShell gets a function that runs bun directly (a .cmd in between would make
 * Ctrl-C in the agent ask "Terminate batch job (Y/N)?").
 */
export function buildBlockBody(shell: SupportedShell, aliasName: string, linkPath: string): string {
  if (shell === "powershell") {
    const launcherPath = quoteForPowerShell(join(linkPath, LAUNCHER_ENTRY_RELATIVE_PATH));
    return `function ${aliasName} { & bun ${launcherPath} @args }`;
  }
  return `alias ${aliasName}=${quoteForPosixShell(join(linkPath, "bin", "j5"))}`;
}

/** Returns the text with every marked block removed, markers included. */
export function removeBlock(text: string): string {
  const keptLines: string[] = [];
  let insideBlock = false;
  for (const line of text.split("\n")) {
    if (line.trimEnd() === BLOCK_BEGIN_MARKER) {
      insideBlock = true;
    } else if (line.trimEnd() === BLOCK_END_MARKER) {
      insideBlock = false;
    } else if (!insideBlock) {
      keptLines.push(line);
    }
  }
  return keptLines.join("\n");
}

/** Returns the text with any earlier block replaced by one holding the body, at the end. */
export function replaceBlock(text: string, blockBody: string): string {
  const withoutBlock = removeBlock(text).replace(/\n*$/, "");
  const separator = withoutBlock === "" ? "" : "\n";
  return `${withoutBlock}${separator}${BLOCK_BEGIN_MARKER}\n${blockBody}\n${BLOCK_END_MARKER}\n`;
}

function isLinkOrJunction(path: string): boolean {
  try {
    // Node reports Windows directory junctions as symbolic links too.
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function linkPointsTo(linkPath: string, repositoryRoot: string): boolean {
  if (!isLinkOrJunction(linkPath)) {
    return false;
  }
  try {
    return realpathSync.native(linkPath) === realpathSync.native(repositoryRoot);
  } catch {
    // A dangling link: its target no longer exists.
    return false;
  }
}

function createLink(linkPath: string, repositoryRoot: string, platform: NodeJS.Platform): void {
  // Junctions need no admin rights or developer mode on Windows; symlinks do.
  symlinkSync(repositoryRoot, linkPath, platform === "win32" ? "junction" : "dir");
}

/** A skill shipped in this repository and where it is installed. */
type SkillPlacement = { skillName: string; sourcePath: string; installedPath: string };

function listSkillPlacements(repositoryRoot: string, homeDirectory: string): SkillPlacement[] {
  const skillsSourceDirectory = join(repositoryRoot, SKILLS_SOURCE_DIRECTORY_NAME);
  if (!existsSync(skillsSourceDirectory)) {
    return [];
  }
  return readdirSync(skillsSourceDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      skillName: entry.name,
      sourcePath: join(skillsSourceDirectory, entry.name),
      installedPath: join(homeDirectory, INSTALLED_SKILLS_RELATIVE_DIRECTORY, entry.name),
    }))
    .toSorted((left, right) => left.skillName.localeCompare(right.skillName));
}

function wasInstalledByThisInstaller(installedPath: string): boolean {
  return existsSync(join(installedPath, INSTALLED_SKILL_MARKER_FILE));
}

function copySkill(placement: SkillPlacement): void {
  rmSync(placement.installedPath, { recursive: true, force: true });
  cpSync(placement.sourcePath, placement.installedPath, { recursive: true });
  writeFileSync(
    join(placement.installedPath, INSTALLED_SKILL_MARKER_FILE),
    `Copied from ${placement.sourcePath} by number-5 scripts/install.ts.\nRe-run the installer to refresh; edits here are overwritten.\n`,
  );
}

/**
 * Runs the installer and returns the report lines it would print.
 * @throws InstallerError for bad options or a path it refuses to replace.
 */
export function runInstaller(
  options: InstallerOptions,
  environment: InstallerEnvironment,
): string[] {
  const report: string[] = [];
  // In --dry-run mode a change is reported as "would ..." and not made.
  const change = (description: string, makeChange: () => void): void => {
    if (options.dryRun) {
      report.push(`would ${description}`);
    } else {
      makeChange();
      report.push(description);
    }
  };

  if (!ALIAS_NAME_PATTERN.test(options.aliasName)) {
    throw new InstallerError(`alias name '${options.aliasName}' must match ${ALIAS_NAME_PATTERN}`);
  }
  const repositoryRoot = resolve(options.repositoryRoot);
  const linkPath = resolve(options.linkPath ?? join(environment.homeDirectory, DEFAULT_LINK_NAME));
  const shell = chooseShell(options.shell, environment);
  const profilePath = options.profilePath ?? chooseProfilePath(shell, environment);
  const profileText = existsSync(profilePath) ? readFileSync(profilePath, "utf8") : "";

  if (options.uninstall) {
    if (profileText.includes(BLOCK_BEGIN_MARKER)) {
      change(`remove the ${options.aliasName} block from ${profilePath}`, () => {
        writeFileSync(profilePath, removeBlock(profileText));
      });
    } else {
      report.push(`no launcher block in ${profilePath}`);
    }
    if (linkPointsTo(linkPath, repositoryRoot)) {
      change(`remove link ${linkPath}`, () => {
        // unlink removes the link or junction itself, never the repository behind it.
        unlinkSync(linkPath);
      });
    } else if (existsSync(linkPath) || isLinkOrJunction(linkPath)) {
      report.push(`left ${linkPath} alone: it is not a link to ${repositoryRoot}`);
    }
    for (const placement of listSkillPlacements(repositoryRoot, environment.homeDirectory)) {
      if (wasInstalledByThisInstaller(placement.installedPath)) {
        change(`remove skill ${placement.skillName} from ${placement.installedPath}`, () => {
          rmSync(placement.installedPath, { recursive: true, force: true });
        });
      }
    }
    report.push(options.dryRun ? "dry run: nothing changed" : "uninstalled; open a new shell");
    return report;
  }

  // 1. Link. Anything that is not a link (a real directory, a file) is never replaced.
  if (linkPointsTo(linkPath, repositoryRoot)) {
    report.push(`link ${linkPath} → ${repositoryRoot} already in place`);
  } else if (isLinkOrJunction(linkPath)) {
    change(`re-point link ${linkPath} → ${repositoryRoot}`, () => {
      unlinkSync(linkPath);
      createLink(linkPath, repositoryRoot, environment.platform);
    });
  } else if (existsSync(linkPath)) {
    // "No disassemble!" (Johnny 5): flavor ahead of the real reason, never instead of it.
    throw new InstallerError(
      `No disassemble! ${linkPath} exists and is not a link; pass --link <other path>`,
    );
  } else {
    change(`create link ${linkPath} → ${repositoryRoot}`, () => {
      createLink(linkPath, repositoryRoot, environment.platform);
    });
  }

  // 2. The alias or function block, replacing any earlier one.
  const blockBody = buildBlockBody(shell, options.aliasName, linkPath);
  change(`write ${options.aliasName} for ${shell} to ${profilePath}: ${blockBody}`, () => {
    mkdirSync(dirname(profilePath), { recursive: true });
    writeFileSync(profilePath, replaceBlock(profileText, blockBody));
  });

  // 3. Skills.
  const skillReport: string[] = [];
  for (const placement of listSkillPlacements(repositoryRoot, environment.homeDirectory)) {
    if (!existsSync(placement.installedPath)) {
      change(`install skill ${placement.skillName} to ${placement.installedPath}`, () => {
        copySkill(placement);
      });
    } else if (wasInstalledByThisInstaller(placement.installedPath)) {
      change(`refresh skill ${placement.skillName} in ${placement.installedPath}`, () => {
        copySkill(placement);
      });
    } else {
      skillReport.push(
        `No disassemble! left ${placement.installedPath} alone: it was not installed by this installer (no ${INSTALLED_SKILL_MARKER_FILE})`,
      );
    }
  }
  report.push(...skillReport);

  // 4. Dependencies.
  if (existsSync(join(repositoryRoot, "node_modules"))) {
    report.push("dependencies already installed");
  } else {
    change(`install dependencies in ${repositoryRoot}`, () => {
      environment.installDependencies(repositoryRoot);
    });
  }

  const reloadHint =
    shell === "powershell"
      ? `. ${quoteForPowerShell(profilePath)}`
      : `source ${quoteForPosixShell(profilePath)}`;
  report.push(
    options.dryRun ? "dry run: nothing changed" : `done; open a new shell or run: ${reloadHint}`,
  );
  return report;
}

function findPowerShellProfilePath(): string | undefined {
  for (const powerShellName of ["pwsh", "powershell"]) {
    if (Bun.which(powerShellName) === null) {
      continue;
    }
    const completedProcess = Bun.spawnSync([
      powerShellName,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$PROFILE",
    ]);
    const profilePath = completedProcess.stdout.toString().trim();
    if (completedProcess.exitCode === 0 && profilePath !== "") {
      return profilePath;
    }
  }
  return undefined;
}

function installDependencies(repositoryRoot: string): void {
  const completedProcess = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], {
    cwd: repositoryRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (completedProcess.exitCode !== 0) {
    throw new InstallerError(`bun install failed in ${repositoryRoot}`);
  }
}

function main(commandLineArguments: string[]): number {
  try {
    const { values } = parseArgs({
      args: commandLineArguments,
      options: {
        link: { type: "string" },
        alias: { type: "string", default: DEFAULT_ALIAS_NAME },
        shell: { type: "string" },
        profile: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        uninstall: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
    if (values.help) {
      console.log(
        "Usage: bun scripts/install.ts [--link PATH] [--alias NAME] [--shell bash|zsh|powershell]\n" +
          "                              [--profile FILE] [--dry-run] [--uninstall]",
      );
      return 0;
    }
    if (values.shell !== undefined && !isSupportedShell(values.shell)) {
      throw new InstallerError(`--shell must be one of: ${SUPPORTED_SHELLS.join(", ")}`);
    }
    const report = runInstaller(
      {
        repositoryRoot: resolve(import.meta.dir, ".."),
        linkPath: values.link,
        aliasName: values.alias,
        shell: values.shell,
        profilePath: values.profile,
        dryRun: values["dry-run"],
        uninstall: values.uninstall,
      },
      {
        platform: process.platform,
        homeDirectory: homedir(),
        loginShellPath: process.env.SHELL,
        findPowerShellProfilePath,
        installDependencies,
      },
    );
    for (const line of report) {
      console.log(line);
    }
    return 0;
  } catch (error) {
    console.error(`install: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(main(Bun.argv.slice(2)));
}
