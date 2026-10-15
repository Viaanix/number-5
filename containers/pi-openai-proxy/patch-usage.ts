// Build-time patch for @victor-software-house/pi-openai-proxy 4.9.5 (see package.json).
//
// The proxy's mapUsage() reports Pi's `input` as OpenAI's `prompt_tokens`. For Anthropic that
// is only the UNCACHED input: cache reads and writes arrive separately as `cacheRead` and
// `cacheWrite`. With prompt caching on, a 9,650-token prompt came back as prompt_tokens 4,
// completion_tokens 4, total_tokens 9650. Docker Agent takes its context size, its
// compaction trigger and its token display from prompt_tokens, so it saw about 0.04% of the
// real context and its counters never accumulated.
//
// OpenAI clients expect prompt_tokens to be the whole prompt, with the cached part broken out
// in prompt_tokens_details. Docker Agent subtracts cached_tokens and cache_write_tokens from
// prompt_tokens to get the fresh remainder (pkg/model/provider/oaistream/adapter.go).
//
// The replacement must match exactly once. If the pinned package changes, the build fails
// here rather than silently shipping an unpatched or half-patched proxy.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TARGET_PATH = join(
  process.cwd(),
  "node_modules",
  "@victor-software-house",
  "pi-openai-proxy",
  "dist",
  "index.mjs",
);

const ORIGINAL = `function mapUsage(usage) {
	return {
		prompt_tokens: usage.input,
		completion_tokens: usage.output,
		total_tokens: usage.totalTokens
	};
}`;

const PATCHED = `function mapUsage(usage) {
	const cacheReadTokens = usage.cacheRead ?? 0;
	const cacheWriteTokens = usage.cacheWrite ?? 0;
	return {
		prompt_tokens: usage.input + cacheReadTokens + cacheWriteTokens,
		completion_tokens: usage.output,
		total_tokens: usage.totalTokens,
		prompt_tokens_details: {
			cached_tokens: cacheReadTokens,
			cache_write_tokens: cacheWriteTokens
		}
	};
}`;

const source = readFileSync(TARGET_PATH, "utf8");
const occurrences = source.split(ORIGINAL).length - 1;
if (occurrences !== 1) {
  console.error(
    `patch-usage: expected exactly one mapUsage() in ${TARGET_PATH}, found ${occurrences}. The pinned proxy package changed; re-check the usage mapping before updating this patch.`,
  );
  process.exit(1);
}
writeFileSync(TARGET_PATH, source.replace(ORIGINAL, PATCHED));
console.log("patch-usage: mapUsage() now reports cache tokens in prompt_tokens");
