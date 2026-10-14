// Tests for scripts/install.ts. Every test uses a temporary home directory; most link
// to a stand-in repository directory so no test can reach the real checkout through a
// link. The end-to-end test links the real repository and runs `daw list` through a
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

import {
  BLOCK_BEGIN_MARKER,
  BLOCK_END_MARKER,
  buildBlockBody,
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

const temporaryDirectories: string[] = [];
afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "daw-install-test-"));
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
  // The Debian/Ubuntu layout: ~/.bashrc sources ~/.bash_aliases.
  writeFileSync(join(homeDirectory, ".bashrc"), "[ -f ~/.bash_aliases ] && . ~/.bash_aliases\n");
  writeFileSync(join(homeDirectory, ".bash_aliases"), `${USER_ALIAS_LINE}\n`);
  const dependencyInstalls: string[] = [];
  return {
    homeDirectory,
    repositoryRoot,
    linkPath: join(homeDirectory, "docker-agent-workflows"),
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
      aliasName: "daw",
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
      `${USER_ALIAS_LINE}\n${BLOCK_BEGIN_MARKER}\nalias daw=${join(sandbox.linkPath, "bin", "daw")}\n${BLOCK_END_MARKER}\n`,
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
    expect(readAliases(sandbox)).not.toContain("alias daw=");
  });

  test("replaces a block written by the earlier bash installer", () => {
    const sandbox = createSandbox();
    writeFileSync(
      join(sandbox.homeDirectory, ".bash_aliases"),
      `${USER_ALIAS_LINE}\n${BLOCK_BEGIN_MARKER}\nalias daw=/old/place/bin/daw\n${BLOCK_END_MARKER}\n`,
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
    expect(() => install(sandbox, { aliasName: "daw; rm -rf ~" })).toThrow("must match");
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
  test("posix alias goes through the link to bin/daw", () => {
    expect(buildBlockBody("zsh", "daw", "/home/me/docker-agent-workflows")).toBe(
      "alias daw=/home/me/docker-agent-workflows/bin/daw",
    );
  });

  test("PowerShell function runs bun on the launcher and forwards its arguments", () => {
    const body = buildBlockBody(
      "powershell",
      "daw",
      join("C:", "Users", "me", "docker-agent-workflows"),
    );
    expect(body).toStartWith("function daw { & bun ");
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
// shell the user would use, load the startup file, and run `daw list`.
describe("installed command runs in a real shell", () => {
  test("daw list works through the installed alias or function", () => {
    const homeDirectory = createTemporaryDirectory();
    const shell = RUNNING_ON_WINDOWS ? "powershell" : "bash";
    const profilePath = join(homeDirectory, RUNNING_ON_WINDOWS ? "profile.ps1" : ".bash_aliases");
    runInstaller(
      {
        repositoryRoot: REPOSITORY_ROOT,
        linkPath: join(homeDirectory, "docker-agent-workflows"),
        aliasName: "daw",
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
      ? ["pwsh", "-NoProfile", "-NonInteractive", "-Command", `. '${profilePath}'; daw list`]
      : ["bash", "-c", `shopt -s expand_aliases; . '${profilePath}'\ndaw list`];
    const completedProcess = Bun.spawnSync(shellCommand, { stdin: "ignore" });
    expect({
      exitCode: completedProcess.exitCode,
      standardError: completedProcess.stderr.toString(),
    }).toEqual({ exitCode: 0, standardError: "" });
    expect(completedProcess.stdout.toString()).toContain("issue-team — ");
  });
});
