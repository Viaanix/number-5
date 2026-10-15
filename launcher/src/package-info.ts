// What the installed package says about itself, read from its package.json.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

const packageManifestSchema = z.object({ name: z.string().min(1), version: z.string().min(1) });

/**
 * Returns the package name and version from <packageRoot>/package.json.
 * @throws Error when the file is missing or has no name and version.
 */
export function readPackageInfo(packageRoot: string): { name: string; version: string } {
  const manifestPath = join(packageRoot, "package.json");
  const parsed = packageManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (!parsed.success) {
    throw new Error(`${manifestPath} must have a name and a version`);
  }
  return parsed.data;
}
