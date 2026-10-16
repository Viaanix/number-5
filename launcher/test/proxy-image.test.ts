// Tests for the proxy-image check: the comparison, how the container is found, and that the
// compose.yaml this package really ships can be read by it.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  checkProxyImage,
  describeDifferentProxyImage,
  judgeProxyImage,
  PROXY_DIRECTORY_PARTS,
  readExpectedProxy,
} from "../src/proxy-image.ts";
import { createTemporaryDirectory, removeTemporaryDirectories } from "./fixtures.ts";

afterAll(removeTemporaryDirectories);

const EXPECTED = "ghcr.io/viaanix/j5-pi-openai-proxy:4.9.6-1";

function packageRootWithCompose(composeText: string | undefined): string {
  const packageRoot = createTemporaryDirectory();
  if (composeText !== undefined) {
    const directory = join(packageRoot, ...PROXY_DIRECTORY_PARTS);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "compose.yaml"), composeText);
  }
  return packageRoot;
}
/** A Docker stand-in that answers `docker ps` and `docker inspect` and records every call. */
function dockerAnswering(containerIds: string, inspectedImages: string) {
  const asked: string[][] = [];
  const runner = (commandWords: string[]) => {
    asked.push(commandWords);
    return commandWords[1] === "ps"
      ? { exitCode: 0, standardOutput: containerIds }
      : { exitCode: 0, standardOutput: inspectedImages };
  };
  return { asked, runner };
}

describe("judgeProxyImage", () => {
  test("the pinned image running is current", () => {
    expect(judgeProxyImage(EXPECTED, [EXPECTED])).toEqual({ kind: "current", image: EXPECTED });
  });

  // Catches the check passing a machine that still serves the old build.
  test("an older tag is different", () => {
    expect(judgeProxyImage(EXPECTED, ["j5-pi-openai-proxy:4.9.5"])).toEqual({
      kind: "different",
      expectedImage: EXPECTED,
      runningImages: ["j5-pi-openai-proxy:4.9.5"],
    });
  });

  // Catches judging only the first container: a leftover on the old image can still answer.
  test("one container on the old image among current ones is different", () => {
    expect(judgeProxyImage(EXPECTED, [EXPECTED, "j5-pi-openai-proxy:4.9.5"]).kind).toBe(
      "different",
    );
  });

  // Catches nagging a machine that has no proxy: no container is "unknown", not a mismatch.
  test("no running container is unknown", () => {
    expect(judgeProxyImage(EXPECTED, [])).toEqual({ kind: "unknown" });
  });
});

describe("describeDifferentProxyImage", () => {
  // Catches a leftover old container next to the current one producing a message that lists the
  // current image as if it were the stale one.
  test("names the images that differ and the expected one, not the current one twice", () => {
    const status = judgeProxyImage(EXPECTED, [EXPECTED, "j5-pi-openai-proxy:4.9.5"]);
    if (status.kind !== "different") {
      throw new Error("the fixture should be a mismatch");
    }

    const message = describeDifferentProxyImage(status);

    expect(message).toContain("the proxy runs j5-pi-openai-proxy:4.9.5, not the");
    expect(message.split(EXPECTED)).toHaveLength(2);
    expect(message).toContain("j5 setup --proxy");
  });
});

describe("checkProxyImage", () => {
  const composeText = `name: some-project\nservices:\n  proxy:\n    image: ${EXPECTED}\n`;

  // Catches looking up the wrong container: the labels come from the compose file's own project
  // name, so a renamed project keeps working. And catches reading the name from `docker ps`,
  // which prints an image ID when the store cannot map the image back to a name: here `ps` only
  // ever yields a container ID, and the name must come from `inspect`.
  test("finds the proxy container by the compose file's project and reads its image from inspect", () => {
    const docker = dockerAnswering("abc123def456\n", `${EXPECTED}\n`);

    const status = checkProxyImage(packageRootWithCompose(composeText), docker.runner);

    expect(status).toEqual({ kind: "current", image: EXPECTED });
    expect(docker.asked).toHaveLength(2);
    expect(docker.asked[0]).toContain("label=com.docker.compose.project=some-project");
    expect(docker.asked[0]).toContain("label=com.docker.compose.service=proxy");
    expect(docker.asked[1]).toEqual([
      "docker",
      "inspect",
      "--format",
      "{{.Config.Image}}",
      "abc123def456",
    ]);
  });

  test("a container created from an older tag is different", () => {
    const docker = dockerAnswering("abc123def456\n", "j5-pi-openai-proxy:4.9.5\n");

    const status = checkProxyImage(packageRootWithCompose(composeText), docker.runner);

    expect(status).toEqual({
      kind: "different",
      expectedImage: EXPECTED,
      runningImages: ["j5-pi-openai-proxy:4.9.5"],
    });
  });

  // Catches a launch failing or warning because Docker is missing, stopped or refusing.
  test("a failing docker command is unknown", () => {
    const status = checkProxyImage(packageRootWithCompose(composeText), () => ({
      exitCode: 127,
      standardOutput: "",
    }));

    expect(status).toEqual({ kind: "unknown" });
  });

  // Catches asking `docker inspect` with no ids, which inspects nothing and fails noisily, and a
  // machine without the proxy being told something about it.
  test("no proxy container is unknown and nothing is inspected", () => {
    const docker = dockerAnswering("\n", "");

    const status = checkProxyImage(packageRootWithCompose(composeText), docker.runner);

    expect(status).toEqual({ kind: "unknown" });
    expect(docker.asked).toHaveLength(1);
  });

  test("a failing inspect is unknown, not a mismatch", () => {
    const status = checkProxyImage(packageRootWithCompose(composeText), (commandWords) =>
      commandWords[1] === "ps"
        ? { exitCode: 0, standardOutput: "abc123def456\n" }
        : { exitCode: 1, standardOutput: "" },
    );

    expect(status).toEqual({ kind: "unknown" });
  });

  test("a package with no compose file is unknown and never runs docker", () => {
    let dockerWasRun = false;

    const status = checkProxyImage(packageRootWithCompose(undefined), () => {
      dockerWasRun = true;
      return { exitCode: 0, standardOutput: EXPECTED };
    });

    expect(status).toEqual({ kind: "unknown" });
    expect(dockerWasRun).toBe(false);
  });

  // Catches a compose file that restructured away from `services.proxy.image` silently turning
  // the check into a no-op that always says nothing.
  test("a compose file without the proxy image is unknown", () => {
    expect(readExpectedProxy(packageRootWithCompose("name: p\nservices:\n  other: {}\n"))).toBe(
      undefined,
    );
  });
});

describe("the shipped compose.yaml", () => {
  // Catches the check going dead after an edit to the real file: if this stops parsing, no
  // machine would ever be warned again and nothing else would fail.
  test("names the project and a published image tag the check can read", () => {
    const repositoryRoot = resolve(import.meta.dir, "..", "..");

    const expected = readExpectedProxy(repositoryRoot);

    expect(expected?.project).toBe("j5-pi-openai-proxy");
    expect(expected?.image).toMatch(/^ghcr\.io\/viaanix\/j5-pi-openai-proxy:\d+\.\d+\.\d+-\d+$/);
  });
});
