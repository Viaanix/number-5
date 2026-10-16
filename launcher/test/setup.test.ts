// Tests for `j5 setup`. The real runSetup runs against temporary directories, with stand-ins for
// the commands, the Docker/Compose calls and the proxy's HTTP answer. Nothing here can reach the
// real home directory, Docker or the network.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import {
  type CommandResult,
  MINIMUM_BUN_VERSION,
  type ProxyModelsResult,
  runSetup,
  type SetupEnvironment,
  type SetupOptions,
  TESTED_DOCKER_AGENT_VERSION,
} from "../src/setup.ts";
import { copySkill, listSkillPlacements } from "../src/skills.ts";
import { createTemporaryDirectory, removeTemporaryDirectories } from "./fixtures.ts";

afterAll(removeTemporaryDirectories);

const GENERATED_TOKEN = "generated-token-0123456789abcdef";

function succeeded(standardOutput: string): CommandResult {
  return { exitCode: 0, standardOutput, standardError: "" };
}
const NOT_FOUND: CommandResult = { exitCode: 127, standardOutput: "", standardError: "not found" };
const FAILED: CommandResult = { exitCode: 1, standardOutput: "", standardError: "failed" };

const HEALTHY_COMMANDS: Record<string, CommandResult> = {
  "git --version": succeeded("git version 2.47.3"),
  "gh --version": succeeded("gh version 2.102.0 (2026-09-30)"),
  "gh auth status": succeeded(""),
  "docker --version": succeeded("Docker version 29.9.1, build abc"),
  "docker version --format {{.Server.Version}}": succeeded("29.9.1"),
  "docker agent version": succeeded(
    `docker agent version ${TESTED_DOCKER_AGENT_VERSION}\nCommit: abc123`,
  ),
};

type HarnessOptions = {
  commands?: Record<string, CommandResult>;
  environmentVariables?: Record<string, string | undefined>;
  /** Exit codes of the attached commands, in call order; 0 when the list runs out. */
  attachedExitCodes?: number[];
  /** Answers to the proxy's model request, in call order; the last one repeats. */
  proxyAnswers?: ProxyModelsResult[];
  skills?: Record<string, string>;
  bunVersion?: string;
};

function createHarness(harnessOptions: HarnessOptions = {}) {
  const packageRoot = createTemporaryDirectory();
  const homeDirectory = createTemporaryDirectory();
  for (const [skillName, content] of Object.entries(harnessOptions.skills ?? { demo: "v1" })) {
    mkdirSync(join(packageRoot, "skills", skillName), { recursive: true });
    writeFileSync(join(packageRoot, "skills", skillName, "SKILL.md"), content);
  }

  const lines: string[] = [];
  const attachedCommands: string[][] = [];
  const proxyRequestPorts: string[] = [];
  const commands = { ...HEALTHY_COMMANDS, ...harnessOptions.commands };
  const attachedExitCodes = [...(harnessOptions.attachedExitCodes ?? [])];
  const proxyAnswers = [
    ...(harnessOptions.proxyAnswers ?? [{ kind: "models", modelIds: ["model-a", "model-b"] }]),
  ] as ProxyModelsResult[];

  const environment: SetupEnvironment = {
    packageRoot,
    homeDirectory,
    platform: process.platform,
    environmentVariables: harnessOptions.environmentVariables ?? {},
    bunVersion: harnessOptions.bunVersion ?? "1.4.2",
    runCommand: (commandWords) => commands[commandWords.join(" ")] ?? NOT_FOUND,
    runAttached: (commandWords) => {
      attachedCommands.push(commandWords);
      return attachedExitCodes.shift() ?? 0;
    },
    fetchProxyModels: (port) => {
      proxyRequestPorts.push(port);
      const answer = proxyAnswers.length > 1 ? proxyAnswers.shift() : proxyAnswers[0];
      return Promise.resolve(answer ?? { kind: "unreachable", reason: "no answer scripted" });
    },
    generateToken: () => GENERATED_TOKEN,
  };

  return {
    packageRoot,
    homeDirectory,
    lines,
    attachedCommands,
    proxyRequestPorts,
    envFilePath: join(homeDirectory, ".config", "cagent", ".env"),
    composeFilePath: join(packageRoot, "containers", "pi-openai-proxy", "compose.yaml"),
    run: (setupOptions: Partial<SetupOptions> = {}) =>
      runSetup(
        { checkOnly: false, withProxy: false, withLogin: false, ...setupOptions },
        environment,
        (line) => lines.push(line),
      ),
    linesStartingWith: (status: string) => lines.filter((line) => line.startsWith(status)),
  };
}

describe("prerequisites", () => {
  test("a healthy machine passes with no warnings", async () => {
    const harness = createHarness();

    expect(await harness.run()).toBe(0);
    expect(harness.linesStartingWith("warning")).toEqual([]);
    expect(harness.linesStartingWith("missing")).toEqual([]);
    expect(harness.lines.at(-1)).toBe("setup done.");
  });

  // Catches a tool that is not installed being reported as fine, which would send a teammate
  // into a confusing failure halfway through their first run.
  test.each([
    ["git --version", "git is not installed"],
    ["gh --version", "gh is not installed"],
    ["docker --version", "docker is not installed"],
  ])("a missing tool (%s) fails setup with a pointer to install it", async (command, hint) => {
    const harness = createHarness({ commands: { [command]: NOT_FOUND } });

    expect(await harness.run()).toBe(1);
    expect(harness.linesStartingWith("missing").join("\n")).toContain(hint);
  });

  // Catches a second, misleading "missing" for docker-agent when Docker itself is the problem.
  test("a missing docker CLI is reported once and not again as a missing plugin", async () => {
    const harness = createHarness({ commands: { "docker --version": NOT_FOUND } });

    await harness.run();

    expect(harness.linesStartingWith("missing")).toHaveLength(1);
    expect(harness.lines.join("\n")).not.toContain("docker-agent");
  });

  test("a gh that is not logged in is a warning, not a failure", async () => {
    const harness = createHarness({ commands: { "gh auth status": FAILED } });

    expect(await harness.run()).toBe(0);
    expect(harness.linesStartingWith("warning").join("\n")).toContain("gh auth login");
  });

  test("an untested docker-agent version is a warning that names the tested one", async () => {
    const harness = createHarness({
      commands: { "docker agent version": succeeded("docker agent version v1.0.0\nCommit: x") },
    });

    expect(await harness.run()).toBe(0);
    const warning = harness.linesStartingWith("warning").join("\n");
    expect(warning).toContain("v1.0.0");
    expect(warning).toContain(TESTED_DOCKER_AGENT_VERSION);
  });

  test("a docker-agent plugin that cannot run fails setup", async () => {
    const harness = createHarness({ commands: { "docker agent version": FAILED } });

    expect(await harness.run()).toBe(1);
    expect(harness.linesStartingWith("missing").join("\n")).toContain("docker-agent plugin");
  });

  // Catches a stopped Docker daemon blocking teammates who only use the teams, or being
  // ignored for the proxy, which cannot run without it.
  test("a stopped Docker daemon fails setup only when the proxy was asked for", async () => {
    const commands = { "docker version --format {{.Server.Version}}": FAILED };

    const withoutProxy = createHarness({ commands });
    expect(await withoutProxy.run()).toBe(0);
    expect(withoutProxy.linesStartingWith("warning").join("\n")).toContain("daemon is not running");

    const withProxy = createHarness({ commands });
    expect(await withProxy.run({ checkOnly: true, withProxy: true })).toBe(1);
    expect(withProxy.linesStartingWith("missing").join("\n")).toContain("daemon is not running");
  });

  // Seen on a teammate's machine: the daemon was running, but their user was not in the docker
  // group. Telling them "the daemon is not running" sent them to restart Docker, which fixes nothing.
  test("a permission error on the Docker socket is not reported as a stopped daemon", async () => {
    const permissionDenied: CommandResult = {
      exitCode: 1,
      standardOutput: "",
      standardError:
        "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock",
    };
    const harness = createHarness({
      commands: { "docker version --format {{.Server.Version}}": permissionDenied },
    });

    expect(await harness.run({ checkOnly: true, withProxy: true })).toBe(1);

    const problem = harness.linesStartingWith("missing").join("\n");
    expect(problem).toContain("permission denied");
    expect(problem).toContain("usermod -aG docker");
    expect(problem).not.toContain("is not running");
  });

  // Catches an old Bun passing as fine: a teammate was on 1.3.13 while the package asks for 1.4.2.
  test.each([
    ["1.3.13", true],
    ["1.4.1", true],
    ["1.4.2", false],
    // A string comparison would call "1.10.0" older than "1.4.2".
    ["1.10.0", false],
    ["2.0.0", false],
  ])("bun %s is warned about: %p", async (bunVersion, expectWarning) => {
    const harness = createHarness({ bunVersion });

    expect(await harness.run()).toBe(0);

    const warnings = harness.linesStartingWith("warning").join("\n");
    if (expectWarning) {
      expect(warnings).toContain(`bun ${bunVersion} is older than ${MINIMUM_BUN_VERSION}`);
      expect(warnings).toContain("bun upgrade");
    } else {
      expect(warnings).toBe("");
    }
  });

  // Catches the warning naming a floor that package.json no longer asks for.
  test("the Bun floor setup warns about is the engines.bun in package.json", () => {
    const packageJson = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
    ) as unknown;
    const enginesBun = z.object({ engines: z.object({ bun: z.string() }) }).parse(packageJson)
      .engines.bun;

    expect(enginesBun).toBe(`>=${MINIMUM_BUN_VERSION}`);
  });

  // Catches setup warning about a docker-agent version that CI does not actually pin: the two
  // would drift when one is upgraded and the other forgotten.
  test("the tested docker-agent version is the one CI installs", () => {
    const workflow = readFileSync(
      join(import.meta.dir, "..", "..", ".github", "workflows", "check.yml"),
      "utf8",
    );
    const pinned = /DOCKER_AGENT_VERSION:\s*"([^"]+)"/.exec(workflow)?.[1];

    expect(pinned).toBe(TESTED_DOCKER_AGENT_VERSION);
  });
});

describe("skills", () => {
  test("--check reports missing and stale skills and writes nothing", async () => {
    const harness = createHarness({ skills: { fresh: "v1", old: "v2" } });
    const placements = listSkillPlacements(harness.packageRoot, harness.homeDirectory);
    const oldPlacement = placements.find((placement) => placement.skillName === "old");
    if (oldPlacement === undefined) {
      throw new Error("fixture has no skill 'old'");
    }
    copySkill(oldPlacement);
    writeFileSync(join(oldPlacement.sourcePath, "SKILL.md"), "v3");

    expect(await harness.run({ checkOnly: true })).toBe(0);

    const warnings = harness.linesStartingWith("warning").join("\n");
    expect(warnings).toContain("skill fresh");
    expect(warnings).toContain("is missing");
    expect(warnings).toContain("skill old");
    expect(warnings).toContain("is stale");
    expect(existsSync(join(harness.homeDirectory, ".agents", "skills", "fresh"))).toBe(false);
    expect(readFileSync(join(oldPlacement.installedPath, "SKILL.md"), "utf8")).toBe("v2");
    expect(harness.lines.at(-1)).toBe("check done; nothing was changed.");
  });

  // The one rule that must hold on every machine: a skill directory this installer did not
  // make is never replaced, however out of date it looks.
  test("a real run installs a missing skill, refreshes a stale one and leaves a foreign one alone", async () => {
    const harness = createHarness({ skills: { added: "new", stale: "v1", foreign: "ours" } });
    const placements = listSkillPlacements(harness.packageRoot, harness.homeDirectory);
    const placementFor = (skillName: string) => {
      const placement = placements.find((candidate) => candidate.skillName === skillName);
      if (placement === undefined) {
        throw new Error(`fixture has no skill '${skillName}'`);
      }
      return placement;
    };
    copySkill(placementFor("stale"));
    writeFileSync(join(placementFor("stale").sourcePath, "SKILL.md"), "v2");
    mkdirSync(placementFor("foreign").installedPath, { recursive: true });
    writeFileSync(join(placementFor("foreign").installedPath, "SKILL.md"), "someone else's");

    expect(await harness.run()).toBe(0);

    expect(readFileSync(join(placementFor("added").installedPath, "SKILL.md"), "utf8")).toBe("new");
    expect(readFileSync(join(placementFor("stale").installedPath, "SKILL.md"), "utf8")).toBe("v2");
    expect(readFileSync(join(placementFor("foreign").installedPath, "SKILL.md"), "utf8")).toBe(
      "someone else's",
    );
    expect(harness.linesStartingWith("warning").join("\n")).toContain("left alone");
    expect(harness.linesStartingWith("changed")).toHaveLength(2);
  });

  test("an up-to-date skill is reported as such and not rewritten", async () => {
    const harness = createHarness();
    await harness.run();
    harness.lines.length = 0;

    await harness.run();

    expect(harness.linesStartingWith("changed")).toEqual([]);
    expect(harness.linesStartingWith("ok").join("\n")).toContain("is up to date");
  });
});

describe("the proxy token", () => {
  test("is created in docker-agent's env file, keeping other entries, owner-only and never printed", async () => {
    const harness = createHarness();
    mkdirSync(join(harness.homeDirectory, ".config", "cagent"), { recursive: true });
    // No trailing newline: the new entry must not be glued onto the last line.
    writeFileSync(harness.envFilePath, "OTHER_SETTING=1");

    expect(await harness.run({ withProxy: true })).toBe(0);

    expect(readFileSync(harness.envFilePath, "utf8")).toBe(
      `OTHER_SETTING=1\nPI_PROXY_AUTH_TOKEN=${GENERATED_TOKEN}\n`,
    );
    if (process.platform !== "win32") {
      expect(statSync(harness.envFilePath).mode & 0o777).toBe(0o600);
    }
    expect(harness.lines.join("\n")).not.toContain(GENERATED_TOKEN);
  });

  // Catches a second run replacing the token the running proxy was started with, which would
  // lock docker-agent out of it ("refused the token") until the proxy was restarted.
  test("an existing token in the env file is reused, never replaced", async () => {
    const harness = createHarness();
    mkdirSync(join(harness.homeDirectory, ".config", "cagent"), { recursive: true });
    const original = 'export PI_PROXY_AUTH_TOKEN="existing-token"\n';
    writeFileSync(harness.envFilePath, original);

    await harness.run({ withProxy: true });

    expect(readFileSync(harness.envFilePath, "utf8")).toBe(original);
    expect(harness.attachedCommands[0]).toContain("--env-file");
  });

  test("a token from the shell is used as is: nothing is written and Compose is not handed the file", async () => {
    const harness = createHarness({
      environmentVariables: { PI_PROXY_AUTH_TOKEN: "from-the-shell" },
    });

    await harness.run({ withProxy: true });

    expect(existsSync(harness.envFilePath)).toBe(false);
    expect(harness.attachedCommands[0]).not.toContain("--env-file");
  });

  test("--check creates no token and starts nothing", async () => {
    const harness = createHarness();

    expect(await harness.run({ checkOnly: true, withProxy: true })).toBe(0);

    expect(existsSync(harness.envFilePath)).toBe(false);
    expect(harness.attachedCommands).toEqual([]);
    expect(harness.linesStartingWith("warning").join("\n")).toContain("j5 setup --proxy");
  });
});

describe("starting the proxy", () => {
  test("runs Compose on the package's own compose file and reports the model count", async () => {
    const harness = createHarness({
      proxyAnswers: [{ kind: "models", modelIds: ["a", "b", "c"] }],
    });

    expect(await harness.run({ withProxy: true })).toBe(0);

    expect(harness.attachedCommands[0]).toEqual([
      "docker",
      "compose",
      "--env-file",
      harness.envFilePath,
      "-f",
      harness.composeFilePath,
      "up",
      "-d",
      "--wait",
    ]);
    expect(harness.linesStartingWith("ok").join("\n")).toContain("serves 3 models");
  });

  // Catches setup claiming success, or asking a dead proxy for models, when Compose failed.
  test("a proxy that fails to start fails setup and is never asked for models", async () => {
    const harness = createHarness({ attachedExitCodes: [1] });

    expect(await harness.run({ withProxy: true })).toBe(1);

    expect(harness.linesStartingWith("missing").join("\n")).toContain("docker compose exited 1");
    expect(harness.proxyRequestPorts).toEqual([]);
  });

  test("a proxy without a Claude login says how to log in", async () => {
    const harness = createHarness({ proxyAnswers: [{ kind: "models", modelIds: [] }] });

    expect(await harness.run({ withProxy: true })).toBe(0);

    expect(harness.linesStartingWith("warning").join("\n")).toContain("j5 setup --login");
  });

  test("a proxy that refuses the token is reported as a token mismatch", async () => {
    const harness = createHarness({ proxyAnswers: [{ kind: "refused", status: 401 }] });

    await harness.run({ withProxy: true });

    expect(harness.linesStartingWith("warning").join("\n")).toContain(
      "different PI_PROXY_AUTH_TOKEN",
    );
  });

  test("an unreachable proxy is a warning with the reason", async () => {
    const harness = createHarness({
      proxyAnswers: [{ kind: "unreachable", reason: "connection refused" }],
    });

    expect(await harness.run({ withProxy: true })).toBe(0);

    expect(harness.linesStartingWith("warning").join("\n")).toContain("connection refused");
  });

  test("the model request uses PI_PROXY_PORT when it is set", async () => {
    const harness = createHarness({ environmentVariables: { PI_PROXY_PORT: "4999" } });

    await harness.run({ withProxy: true });

    expect(harness.proxyRequestPorts).toEqual(["4999"]);
  });
});

describe("the proxy image", () => {
  const PINNED_IMAGE = "ghcr.io/viaanix/j5-pi-openai-proxy:4.9.6-1";
  const LIST_PROXY_CONTAINERS =
    "docker ps --filter label=com.docker.compose.project=j5-pi-openai-proxy --filter label=com.docker.compose.service=proxy --format {{.Image}}";

  function createHarnessWithCompose(runningImages: string | undefined) {
    const harness = createHarness({
      environmentVariables: { PI_PROXY_AUTH_TOKEN: "from-the-shell" },
      commands:
        runningImages === undefined ? {} : { [LIST_PROXY_CONTAINERS]: succeeded(runningImages) },
    });
    mkdirSync(join(harness.packageRoot, "containers", "pi-openai-proxy"), { recursive: true });
    writeFileSync(
      harness.composeFilePath,
      `name: j5-pi-openai-proxy\nservices:\n  proxy:\n    image: ${PINNED_IMAGE}\n`,
    );
    return harness;
  }

  // Catches the bug this exists for: a machine still on the old image sees no hint that Opus 5.5
  // will be rejected, and finds out from Anthropic's version error in the middle of a run.
  test("--check warns when the running proxy is on another image, naming both, and still exits 0", async () => {
    const harness = createHarnessWithCompose("j5-pi-openai-proxy:4.9.5");

    expect(await harness.run({ checkOnly: true, withProxy: true })).toBe(0);

    const warnings = harness.linesStartingWith("warning").join("\n");
    expect(warnings).toContain("j5-pi-openai-proxy:4.9.5");
    expect(warnings).toContain(PINNED_IMAGE);
    expect(warnings).toContain("j5 setup --proxy");
  });

  test("--check says nothing is wrong when the running image is the pinned one", async () => {
    const harness = createHarnessWithCompose(PINNED_IMAGE);

    await harness.run({ checkOnly: true, withProxy: true });

    expect(harness.linesStartingWith("ok").join("\n")).toContain(`proxy image ${PINNED_IMAGE}`);
    expect(harness.linesStartingWith("warning").join("\n")).not.toContain("this j5 expects");
  });

  // Catches a machine without the proxy (no container, or Docker answering nothing) being
  // nagged about an image it does not run.
  test("reports nothing about the image when no proxy container is running", async () => {
    const harness = createHarnessWithCompose(undefined);

    await harness.run({ checkOnly: true, withProxy: true });

    expect(harness.lines.join("\n")).not.toContain("proxy image");
    expect(harness.lines.join("\n")).not.toContain("this j5 expects");
  });

  // Catches the check running only in --check: after Compose recreates the proxy, setup must
  // confirm the new container really is on the pinned image.
  test("a real start checks the image after Compose brought the proxy up", async () => {
    const harness = createHarnessWithCompose(PINNED_IMAGE);

    await harness.run({ withProxy: true });

    expect(harness.linesStartingWith("ok").join("\n")).toContain(`proxy image ${PINNED_IMAGE}`);
  });
});

describe("logging the proxy in", () => {
  test("opens Pi through Compose after the proxy is up, then re-checks the models", async () => {
    const harness = createHarness({
      proxyAnswers: [
        { kind: "models", modelIds: [] },
        { kind: "models", modelIds: ["claude-sonnet-5-5"] },
      ],
    });

    expect(await harness.run({ withProxy: true, withLogin: true })).toBe(0);

    expect(harness.attachedCommands).toHaveLength(2);
    expect(harness.attachedCommands[1]).toEqual([
      "docker",
      "compose",
      "--env-file",
      harness.envFilePath,
      "-f",
      harness.composeFilePath,
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "bun",
      "proxy",
      "/app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--offline",
    ]);
    expect(harness.linesStartingWith("ok").join("\n")).toContain("serves 1 models");
  });

  // Catches --login opening an interactive session for someone who is already logged in.
  test("does not open Pi when the proxy already has models", async () => {
    const harness = createHarness();

    await harness.run({ withProxy: true, withLogin: true });

    expect(harness.attachedCommands).toHaveLength(1);
  });

  test("a Pi that exits non-zero is a warning, not a failure", async () => {
    const harness = createHarness({
      attachedExitCodes: [0, 1],
      proxyAnswers: [{ kind: "models", modelIds: [] }],
    });

    expect(await harness.run({ withProxy: true, withLogin: true })).toBe(0);

    expect(harness.linesStartingWith("warning").join("\n")).toContain("Pi exited 1");
  });
});
