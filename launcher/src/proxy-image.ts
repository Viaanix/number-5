// Is the proxy container on this machine running the image this j5 expects?
//
// The teams name models that only a recent proxy image can serve: an image built on an older Pi
// answers "Claude Code 2.1.75 does not support this model" for claude-opus-5-5, and the agent
// fails with that on its first call. This file finds the running proxy container and compares its
// image with the tag in the compose.yaml that ships with this j5. That is the whole meaning of
// "latest" here: the tag this j5 pins. Asking the registry would need a ghcr.io login, and CI
// refuses to publish one tag twice, so the pinned tag identifies one build.
//
// The check is advisory. Every way it can fail to learn something (no Docker, no container, a
// compose file it cannot read) is "unknown" and reported as nothing, because a machine with no
// proxy must see no warning and a launch must never fail on it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

/** Where the proxy's compose file lives under the package root (clone or installed package). */
export const PROXY_DIRECTORY_PARTS = ["containers", "pi-openai-proxy"];

const COMPOSE_FILE_NAME = "compose.yaml";
const PROXY_SERVICE_NAME = "proxy";
const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";

const composeFileSchema = z.looseObject({
  name: z.string().min(1),
  services: z.looseObject({ [PROXY_SERVICE_NAME]: z.looseObject({ image: z.string().min(1) }) }),
});

/** What the compose file pins: the project name Compose labels containers with, and the image. */
export type ExpectedProxy = { project: string; image: string };

/** How one command ran. Setup's CommandResult satisfies this. */
type CommandRunner = (commandWords: string[]) => { exitCode: number; standardOutput: string };

export type ProxyImageStatus =
  | { kind: "current"; image: string }
  | { kind: "different"; expectedImage: string; runningImages: string[] }
  | { kind: "unknown" };

/** The project and image tag this j5 pins, or undefined when the compose file is missing or odd. */
export function readExpectedProxy(packageRoot: string): ExpectedProxy | undefined {
  const composeFilePath = join(packageRoot, ...PROXY_DIRECTORY_PARTS, COMPOSE_FILE_NAME);
  if (!existsSync(composeFilePath)) {
    return undefined;
  }
  try {
    const parsed = composeFileSchema.safeParse(
      Bun.YAML.parse(readFileSync(composeFilePath, "utf8")),
    );
    return parsed.success
      ? { project: parsed.data.name, image: parsed.data.services[PROXY_SERVICE_NAME].image }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Compares the images of the running proxy containers with the expected one. Current only when
 * there is at least one container and every one runs the expected image: a container left over
 * from an old image next to a new one is still a machine that can answer from the old one.
 */
export function judgeProxyImage(expectedImage: string, runningImages: string[]): ProxyImageStatus {
  if (runningImages.length === 0) {
    return { kind: "unknown" };
  }
  return runningImages.every((image) => image === expectedImage)
    ? { kind: "current", image: expectedImage }
    : { kind: "different", expectedImage, runningImages };
}

function nonEmptyLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Finds the running proxy container by its Compose labels and judges its image.
 *
 * The image comes from `docker inspect`'s Config.Image, the reference the container was created
 * from, and not from the Image column of `docker ps`: that column prints the image's ID when the
 * image store can no longer map the container's image back to a name (seen 2026-10-16 on a live,
 * correct container whose tag had since been rebuilt), which made a current proxy look stale.
 */
export function checkProxyImage(packageRoot: string, runCommand: CommandRunner): ProxyImageStatus {
  const expected = readExpectedProxy(packageRoot);
  if (expected === undefined) {
    return { kind: "unknown" };
  }
  const listing = runCommand([
    "docker",
    "ps",
    "--quiet",
    "--filter",
    `label=${COMPOSE_PROJECT_LABEL}=${expected.project}`,
    "--filter",
    `label=${COMPOSE_SERVICE_LABEL}=${PROXY_SERVICE_NAME}`,
  ]);
  const containerIds = listing.exitCode === 0 ? nonEmptyLines(listing.standardOutput) : [];
  if (containerIds.length === 0) {
    return { kind: "unknown" };
  }
  const inspection = runCommand([
    "docker",
    "inspect",
    "--format",
    "{{.Config.Image}}",
    ...containerIds,
  ]);
  if (inspection.exitCode !== 0) {
    return { kind: "unknown" };
  }
  return judgeProxyImage(expected.image, nonEmptyLines(inspection.standardOutput));
}

/** The line a mismatch is reported with, shared by `j5 setup` and the launch warning. */
export function describeDifferentProxyImage(
  status: Extract<ProxyImageStatus, { kind: "different" }>,
): string {
  // Only the images that differ: a stale container next to a current one must not make the
  // current image look like the problem.
  const staleImages = status.runningImages.filter((image) => image !== status.expectedImage);
  return `the proxy runs ${staleImages.join(", ")}, not the ${status.expectedImage} this j5 expects. Its teams may use models the older image cannot serve (claude-opus-5-5 needs 4.9.6-1 or later). Run: j5 setup --proxy (recreates the proxy, which interrupts a run in progress)`;
}
