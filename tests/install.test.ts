// Tests for scripts/install.ts. Every test uses a temporary home directory; most link
// to a stand-in repository directory so no test can reach the real checkout through a
// link. The end-to-end test links the real repository and runs `j5 list` through a
// real shell on each OS.

import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { quoteForPosixShell } from "../launcher/src/shell-quote.ts";
import {
  BLOCK_BEGIN_MARKER,
  BLOCK_END_MARKER,
  buildBlockBody,
  INSTALLED_SKILL_MARKER_FILE,
  chooseProfilePath,
  chooseShell,
  type InstallerEnvironment,
  type InstallerOptions,
  removeBlock,
  replaceBlock,
  runInstaller,
} from "../scripts/install.ts";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const RUNNING_ON_WINDOWS = process.platform === "win32";
const USER_ALIAS_LINE = "alias gs='git status'";
const SAMPLE_SKILL_TEXT = '---\nname: sample-skill\ndescription: "A sample."\n---\nBody\n';

const temporaryDirectories: string[] = [];
afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "j5-install-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

type Sandbox = {
  homeDirectory: string;
  /** A stand-in for the repository: has node_modules, so no install is attempted. */
  repositoryRoot: string;
  linkPath: string;
  /** Repository roots installDependencies was called with. */
  dependencyInstalls: string[];
  environment: InstallerEnvironment;
};

function createSandbox(overrides: Partial<InstallerEnvironment> = {}): Sandbox {
  const root = createTemporaryDirectory();
  const homeDirectory = join(root, "home");
  const repositoryRoot = join(root, "repository");
  mkdirSync(homeDirectory);
  mkdirSync(join(repositoryRoot, "node_modules"), { recursive: true });
  // A skill shipped by the stand-in repository.
  mkdirSync(join(repositoryRoot, "skills", "sample-skill", "references"), { recursive: true });
  writeFileSync(join(repositoryRoot, "skills", "sample-skill", "SKILL.md"), SAMPLE_SKILL_TEXT);
  writeFileSync(
    join(repositoryRoot, "skills", "sample-skill", "references", "notes.md"),
    "notes\n",
  );
  // The Debian/Ubuntu layout: ~/.bashrc sources ~/.bash_aliases.
  writeFileSync(join(homeDirectory, ".bashrc"), "[ -f ~/.bash_aliases ] && . ~/.bash_aliases\n");
  writeFileSync(join(homeDirectory, ".bash_aliases"), `${USER_ALIAS_LINE}\n`);
  const dependencyInstalls: string[] = [];
  return {
    homeDirectory,
    repositoryRoot,
    linkPath: join(homeDirectory, "number-5"),
    dependencyInstalls,
    environment: {
      platform: "linux",
      homeDirectory,
      loginShellPath: "/bin/bash",
      findPowerShellProfilePath: () => undefined,
      installDependencies: (installedRepositoryRoot) => {
        dependencyInstalls.push(installedRepositoryRoot);
      },
      ...overrides,
    },
  };
}

function install(sandbox: Sandbox, options: Partial<InstallerOptions> = {}): string[] {
  return runInstaller(
    {
      repositoryRoot: sandbox.repositoryRoot,
      linkPath: undefined,
      aliasName: "j5",
      shell: undefined,
      profilePath: undefined,
      dryRun: false,
      uninstall: false,
      ...options,
    },
    sandbox.environment,
  );
}

function readAliases(sandbox: Sandbox): string {
  return readFileSync(join(sandbox.homeDirectory, ".bash_aliases"), "utf8");
}

function countOccurrences(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

// Links are created with the host's own call (symlink here, junction on Windows),
// so these run on every OS even though the environment says linux.
describe("runInstaller — install", () => {
  test("links the home directory to the repository and adds an alias through the link", () => {
    const sandbox = createSandbox();
    install(sandbox);
    expect(lstatSync(sandbox.linkPath).isSymbolicLink()).toBe(true);
    expect(realpathSync.native(sandbox.linkPath)).toBe(realpathSync.native(sandbox.repositoryRoot));
    expect(readAliases(sandbox)).toBe(
      `${USER_ALIAS_LINE}\n${BLOCK_BEGIN_MARKER}\nalias j5=${quoteForPosixShell(join(sandbox.linkPath, "bin", "j5"))}\n${BLOCK_END_MARKER}\n`,
    );
  });

  test("running twice leaves exactly one block", () => {
    const sandbox = createSandbox();
    install(sandbox);
    install(sandbox);
    expect(countOccurrences(readAliases(sandbox), BLOCK_BEGIN_MARKER)).toBe(1);
  });

  test("a new alias name replaces the old one instead of adding a second", () => {
    const sandbox = createSandbox();
    install(sandbox);
    install(sandbox, { aliasName: "agents" });
    expect(readAliases(sandbox)).toContain("alias agents=");
    expect(readAliases(sandbox)).not.toContain("alias j5=");
  });

  test("replaces a block written by the earlier bash installer", () => {
    const sandbox = createSandbox();
    writeFileSync(
      join(sandbox.homeDirectory, ".bash_aliases"),
      `${USER_ALIAS_LINE}\n${BLOCK_BEGIN_MARKER}\nalias j5=/old/place/bin/j5\n${BLOCK_END_MARKER}\n`,
    );
    install(sandbox);
    expect(readAliases(sandbox)).not.toContain("/old/place");
    expect(countOccurrences(readAliases(sandbox), BLOCK_BEGIN_MARKER)).toBe(1);
  });

  test("refuses to replace a real directory at the link path, and leaves it intact", () => {
    const sandbox = createSandbox();
    mkdirSync(sandbox.linkPath);
    writeFileSync(join(sandbox.linkPath, "keep-me"), "");
    expect(() => install(sandbox)).toThrow("exists and is not a link");
    expect(existsSync(join(sandbox.linkPath, "keep-me"))).toBe(true);
  });

  test("re-points a link left from an earlier clone location", () => {
    const sandbox = createSandbox();
    const oldClone = createTemporaryDirectory();
    symlinkSync(oldClone, sandbox.linkPath, RUNNING_ON_WINDOWS ? "junction" : "dir");
    install(sandbox);
    expect(realpathSync.native(sandbox.linkPath)).toBe(realpathSync.native(sandbox.repositoryRoot));
    expect(existsSync(oldClone)).toBe(true);
  });

  test("installs dependencies only when node_modules is missing", () => {
    const sandbox = createSandbox();
    install(sandbox);
    expect(sandbox.dependencyInstalls).toEqual([]);
    rmSync(join(sandbox.repositoryRoot, "node_modules"), { recursive: true });
    install(sandbox);
    expect(sandbox.dependencyInstalls).toEqual([resolve(sandbox.repositoryRoot)]);
  });

  test("--dry-run changes nothing and says so", () => {
    const sandbox = createSandbox();
    const aliasesBefore = readAliases(sandbox);
    const report = install(sandbox, { dryRun: true });
    expect(existsSync(sandbox.linkPath)).toBe(false);
    expect(readAliases(sandbox)).toBe(aliasesBefore);
    // The report describes the plan and claims no completed change.
    expect(report.some((line) => line.startsWith("would create link "))).toBe(true);
    expect(report.some((line) => /^(create|write|re-point) /.test(line))).toBe(false);
    expect(report.at(-1)).toBe("dry run: nothing changed");
  });

  test("rejects an alias name that is not a shell word", () => {
    const sandbox = createSandbox();
    expect(() => install(sandbox, { aliasName: "j5; rm -rf ~" })).toThrow("must match");
  });
});

describe("runInstaller — uninstall", () => {
  test("removes the block and the link, keeps the user's lines and the repository", () => {
    const sandbox = createSandbox();
    install(sandbox);
    install(sandbox, { uninstall: true });
    expect(existsSync(sandbox.linkPath)).toBe(false);
    expect(readAliases(sandbox)).toBe(`${USER_ALIAS_LINE}\n`);
    expect(existsSync(join(sandbox.repositoryRoot, "node_modules"))).toBe(true);
  });

  test("--dry-run changes nothing and says so", () => {
    const sandbox = createSandbox();
    install(sandbox);
    const aliasesBefore = readAliases(sandbox);
    const report = install(sandbox, { uninstall: true, dryRun: true });
    expect(lstatSync(sandbox.linkPath).isSymbolicLink()).toBe(true);
    expect(readAliases(sandbox)).toBe(aliasesBefore);
    expect(report.some((line) => line.startsWith("remove"))).toBe(false);
    expect(report.at(-1)).toBe("dry run: nothing changed");
  });

  test("leaves a link that points somewhere else", () => {
    const sandbox = createSandbox();
    symlinkSync(
      createTemporaryDirectory(),
      sandbox.linkPath,
      RUNNING_ON_WINDOWS ? "junction" : "dir",
    );
    install(sandbox, { uninstall: true });
    expect(lstatSync(sandbox.linkPath).isSymbolicLink()).toBe(true);
  });
});

describe("chooseShell", () => {
  test("uses PowerShell on Windows regardless of SHELL", () => {
    expect(
      chooseShell(
        undefined,
        createSandbox({ platform: "win32", loginShellPath: "/bin/bash" }).environment,
      ),
    ).toBe("powershell");
  });

  test("uses the login shell's name on Linux and macOS", () => {
    expect(
      chooseShell(
        undefined,
        createSandbox({ platform: "darwin", loginShellPath: "/bin/zsh" }).environment,
      ),
    ).toBe("zsh");
  });

  test("an explicit --shell wins", () => {
    expect(chooseShell("bash", createSandbox({ loginShellPath: "/bin/zsh" }).environment)).toBe(
      "bash",
    );
  });

  test("refuses a shell it cannot configure, naming the flag", () => {
    expect(() =>
      chooseShell(undefined, createSandbox({ loginShellPath: "/usr/bin/fish" }).environment),
    ).toThrow("pass --shell bash, zsh or powershell");
  });
});

describe("chooseProfilePath", () => {
  test("zsh: ~/.zshrc", () => {
    const sandbox = createSandbox();
    expect(chooseProfilePath("zsh", sandbox.environment)).toBe(
      join(sandbox.homeDirectory, ".zshrc"),
    );
  });

  test("bash on macOS: ~/.bash_profile, which login shells read", () => {
    const sandbox = createSandbox({ platform: "darwin" });
    expect(chooseProfilePath("bash", sandbox.environment)).toBe(
      join(sandbox.homeDirectory, ".bash_profile"),
    );
  });

  test("bash on Linux: ~/.bash_aliases when ~/.bashrc sources it", () => {
    const sandbox = createSandbox();
    expect(chooseProfilePath("bash", sandbox.environment)).toBe(
      join(sandbox.homeDirectory, ".bash_aliases"),
    );
  });

  test("bash on Linux: ~/.bashrc when it does not source ~/.bash_aliases", () => {
    const sandbox = createSandbox();
    writeFileSync(join(sandbox.homeDirectory, ".bashrc"), "export EDITOR=vim\n");
    expect(chooseProfilePath("bash", sandbox.environment)).toBe(
      join(sandbox.homeDirectory, ".bashrc"),
    );
  });

  test("PowerShell: the $PROFILE path PowerShell reports", () => {
    const sandbox = createSandbox({
      findPowerShellProfilePath: () => "C:\\Users\\me\\profile.ps1",
    });
    expect(chooseProfilePath("powershell", sandbox.environment)).toBe("C:\\Users\\me\\profile.ps1");
  });

  test("PowerShell: refuses without a PowerShell to ask, naming the flag", () => {
    expect(() => chooseProfilePath("powershell", createSandbox().environment)).toThrow(
      "pass --profile <file>",
    );
  });
});

describe("block text", () => {
  test("posix alias goes through the link to bin/j5", () => {
    // join() gives backslashes on Windows, which POSIX quoting then quotes.
    const linkPath = join("home", "me", "number-5");
    expect(buildBlockBody("zsh", "j5", linkPath)).toBe(
      `alias j5=${quoteForPosixShell(join(linkPath, "bin", "j5"))}`,
    );
  });

  test("PowerShell function runs bun on the launcher and forwards its arguments", () => {
    const body = buildBlockBody("powershell", "j5", join("C:", "Users", "me", "number-5"));
    expect(body).toStartWith("function j5 { & bun ");
    expect(body).toEndWith(" @args }");
    expect(body).toContain(join("launcher", "src", "cli.ts"));
  });

  test("replaceBlock keeps surrounding lines and puts one block at the end", () => {
    const before = `one\n${BLOCK_BEGIN_MARKER}\nold\n${BLOCK_END_MARKER}\ntwo\n`;
    expect(replaceBlock(before, "new")).toBe(
      `one\ntwo\n${BLOCK_BEGIN_MARKER}\nnew\n${BLOCK_END_MARKER}\n`,
    );
  });

  test("removeBlock tolerates CRLF line endings, as PowerShell profiles may have", () => {
    expect(removeBlock(`one\r\n${BLOCK_BEGIN_MARKER}\r\nold\r\n${BLOCK_END_MARKER}\r\ntwo`)).toBe(
      "one\r\ntwo",
    );
  });
});

// End to end: install for the real repository into a temporary home, then start the
// shell the user would use, load the startup file, and run `j5 list`.
describe("installed command runs in a real shell", () => {
  test("j5 list works through the installed alias or function", () => {
    const homeDirectory = createTemporaryDirectory();
    const shell = RUNNING_ON_WINDOWS ? "powershell" : "bash";
    const profilePath = join(homeDirectory, RUNNING_ON_WINDOWS ? "profile.ps1" : ".bash_aliases");
    runInstaller(
      {
        repositoryRoot: REPOSITORY_ROOT,
        linkPath: join(homeDirectory, "number-5"),
        aliasName: "j5",
        shell,
        profilePath,
        dryRun: false,
        uninstall: false,
      },
      {
        platform: process.platform,
        homeDirectory,
        loginShellPath: undefined,
        findPowerShellProfilePath: () => undefined,
        installDependencies: () => {
          throw new Error("the repository's node_modules should already exist");
        },
      },
    );
    const shellCommand = RUNNING_ON_WINDOWS
      ? ["pwsh", "-NoProfile", "-NonInteractive", "-Command", `. '${profilePath}'; j5 list`]
      : ["bash", "-c", `shopt -s expand_aliases; . '${profilePath}'\nj5 list`];
    const completedProcess = Bun.spawnSync(shellCommand, { stdin: "ignore" });
    expect({
      exitCode: completedProcess.exitCode,
      standardError: completedProcess.stderr.toString(),
    }).toEqual({ exitCode: 0, standardError: "" });
    expect(completedProcess.stdout.toString()).toContain("issue-team — ");
  });
});

// Where the stand-in repository's sample skill is installed.
function installedSkillPath(sandbox: Sandbox): string {
  return join(sandbox.homeDirectory, ".agents", "skills", "sample-skill");
}

describe("runInstaller — skills", () => {
  test("copies each repository skill into ~/.agents/skills as a real directory, marked", () => {
    const sandbox = createSandbox();
    install(sandbox);
    const skillPath = installedSkillPath(sandbox);
    // docker-agent skips symlinked skill directories, so this must be a copy.
    expect(lstatSync(skillPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(skillPath, "SKILL.md"), "utf8")).toBe(SAMPLE_SKILL_TEXT);
    expect(readFileSync(join(skillPath, "references", "notes.md"), "utf8")).toBe("notes\n");
    expect(existsSync(join(skillPath, INSTALLED_SKILL_MARKER_FILE))).toBe(true);
  });

  test("a re-run refreshes its own copy, dropping files removed from the repository", () => {
    const sandbox = createSandbox();
    install(sandbox);
    writeFileSync(join(installedSkillPath(sandbox), "stale.md"), "from an older version\n");
    writeFileSync(join(sandbox.repositoryRoot, "skills", "sample-skill", "SKILL.md"), "updated\n");
    install(sandbox);
    expect(readFileSync(join(installedSkillPath(sandbox), "SKILL.md"), "utf8")).toBe("updated\n");
    expect(existsSync(join(installedSkillPath(sandbox), "stale.md"))).toBe(false);
  });

  test("never overwrites a same-named skill it did not install, and says so", () => {
    const sandbox = createSandbox();
    mkdirSync(installedSkillPath(sandbox), { recursive: true });
    writeFileSync(join(installedSkillPath(sandbox), "SKILL.md"), "the user's own skill\n");
    const report = install(sandbox);
    expect(readFileSync(join(installedSkillPath(sandbox), "SKILL.md"), "utf8")).toBe(
      "the user's own skill\n",
    );
    expect(report).toContain(
      `left ${installedSkillPath(sandbox)} alone: it was not installed by this installer (no ${INSTALLED_SKILL_MARKER_FILE})`,
    );
  });

  test("uninstall removes its own copy and leaves a skill it did not install", () => {
    const sandbox = createSandbox();
    install(sandbox);
    const foreignSkillPath = join(sandbox.homeDirectory, ".agents", "skills", "users-own");
    mkdirSync(foreignSkillPath, { recursive: true });
    install(sandbox, { uninstall: true });
    expect(existsSync(installedSkillPath(sandbox))).toBe(false);
    expect(existsSync(foreignSkillPath)).toBe(true);
  });

  test("--dry-run installs no skill", () => {
    const sandbox = createSandbox();
    const report = install(sandbox, { dryRun: true });
    expect(existsSync(installedSkillPath(sandbox))).toBe(false);
    expect(report).toContain(`would install skill sample-skill to ${installedSkillPath(sandbox)}`);
  });
});
