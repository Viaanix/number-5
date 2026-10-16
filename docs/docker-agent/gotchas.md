# docker-agent gotchas

Behavior that surprised someone, with the receipt that proves it. Every entry names the docker-agent version it was observed on; re-run the receipt after upgrading and update or delete the entry.

**Adding an entry:** one heading per gotcha, then **Observed** (version, date), **Receipt** (the exact command and the output that shows it), **Consequence**, **Mitigation**. Entries without a receipt go under [Unverified](#unverified) until someone runs one.

Check the installed version with `docker agent version`.

---

## Flavors and configuration

### An unknown `--flavor` is silently ignored

**Observed:** v1.145.0, 2026-10-14.

**Receipt:**
```bash
diff <(docker agent debug config team.yaml) <(docker agent debug config team.yaml --flavor nope) \
  && echo "IDENTICAL: unknown flavor is a silent no-op"
# → IDENTICAL: unknown flavor is a silent no-op   (exit 0, nothing on stderr)
docker agent run team.yaml --dry-run --flavor nope "x"   # exit 0 as well
```

**Consequence:** `--flavor lwo` runs the team at its default settings and nothing tells you.

**Mitigation:** `j5` reads the flavor names from `team.yaml` and rejects anything else (`launcher/src/parameters.ts`, `describeInvalidEffort`). Do the same check in any other wrapper.

### A flavor that repeats the base values applies without a word

**Observed:** v1.145.0, 2026-10-14.

**Receipt:** a flavor `same: { agents: { builder: { harness: { effort: high } } } }` on a team whose builder is already `high`: `debug config --flavor same` exits 0, and the output equals the base config minus its `flavors:` section.

**Consequence:** a flavor can look meaningful in review and change nothing.

**Mitigation:** `bun run validate:teams` fails any flavor whose resolved config equals the base.

What docker-agent *does* catch in a flavor, both at `debug config` and at `run`:
- an unknown key: `agent:` instead of `agents:` → `unknown field "agent"`;
- a misspelled agent name: it creates a new, incomplete agent → `harness.type is required`;
- an invalid harness effort → `harness.effort must be one of: low, medium, high, xhigh, max`.

### Flavors deep-merge

**Observed:** v1.145.0, 2026-10-14.

**Receipt:** a flavor with `models: { lead: { model: claude-haiku-4-5 } }`, resolved with `docker agent debug config team.yaml --flavor low`, keeps `provider: anthropic` from the base and changes only `model`. With a flavor applied, `debug config` no longer prints the `flavors:` section.

**Consequence:** a flavor only needs the keys it changes. Lists are not checked yet; assume a list in a flavor replaces the base list until someone verifies it.

## Running and dry runs

### `run --dry-run` accepts an agent the team does not define

**Observed:** v1.145.0, 2026-10-14.

**Receipt:**
```bash
docker agent run workflows/issue-team/team.yaml --agent closer --dry-run --exec x
# → Dry run mode enabled. Agent initialized but will not execute.   (exit 0; there is no agent "closer")
```

**Consequence:** a dry run is not proof that `-a <name>` is right.

**Mitigation:** `j5` and `validate:teams` check every entry point's agent against the `agents:` keys in `team.yaml`.

### `run --dry-run --worktree=<name>` creates no worktree

**Observed:** v1.145.0, 2026-10-14.

**Receipt:** in a scratch repository, `docker agent run team.yaml --dry-run --exec --worktree=probe "x"` exits 0; `git worktree list` and `ls ~/.cagent/worktrees` are unchanged.

**Consequence (useful):** a dry run is a safe way to check that a full command line parses, worktree flags included.

### `run --dry-run` still requires the provider's API key to be set

**Observed:** v1.145.0, 2026-10-14.

**Receipt:**
```bash
env -u ANTHROPIC_API_KEY docker agent run workflows/issue-team/team.yaml --config-dir <empty dir> --dry-run --exec x
# → "Welcome to docker agent!" setup flow, exit 255 (in CI: "The following environment variables must be set: ANTHROPIC_API_KEY")
ANTHROPIC_API_KEY=placeholder docker agent run workflows/issue-team/team.yaml --config-dir <empty dir> --dry-run --exec x
# → Dry run mode enabled. Agent initialized but will not execute.   (exit 0)
```

**Consequence:** a dry run checks that the key is present, not that it is valid. CI needs a value even though no model is called.

**Scope:** native model agents only. A config whose agents are all `harness: claude-code` dry-runs with no key, an empty `--config-dir`, and no `claude` on `PATH` (issue-team and test-quality, 2026-10-14: `Dry run mode enabled…`, exit 0). CI now supplies a placeholder `PI_PROXY_AUTH_TOKEN` for native pr-reviewer initialization; it does not need `ANTHROPIC_API_KEY` or a running proxy for these dry runs.

### Claude through an OpenAI-compatible proxy needs explicit reasoning fields

**Observed:** Docker Agent v1.145.0, pi-openai-proxy 4.9.5, locked Pi adapter 0.73.1, 2026-10-15.

**Receipt:** after adding Sonnet 5.5 through Pi's supported `models.json`, a native
tool probe with `thinking_budget: high` failed before any tool call:

```text
model failed: ... 400 ... To turn thinking off on this model, send "thinking":
{"type": "between_tools"} instead of {"type": "disabled"}.
```

Docker Agent's OpenAI client does not classify Claude as an OpenAI reasoning
model, so that setting does not send the proxy's `reasoning_effort`. Using
`provider_opts: { extra_body: { reasoning_effort: high } }` instead completed two
real script-tool turns on `claude-sonnet-5-5`, exit 0. Haiku 5.5 with explicit
`medium` effort passed the same probe. The configured model names were recorded
in `agent_info`; the scripts generated values not present in the prompts and
both values returned in the final responses.

The full workflow command also passed:

```bash
bin/j5 pr-reviewer review --pr 12 --project <scratch> -- --exec --json --safety autonomous
# agent_info: pi/claude-sonnet-5-5
# pr_context -> native read-only file inspection -> pr_context
# SHA-identifying local verdict; exit 0; worktree unchanged
```

**Consequence:** a new catalogue entry is not sufficient proof of request
compatibility. Keep model-specific request settings explicit and verify the tool
loop, not only model discovery. This receipt does not establish signed-history
portability or thinking visibility through an OpenAI translator.

### Token counters through the proxy ignore cached input, so compaction cannot trigger

**Observed:** v1.145.0, pi-openai-proxy 4.9.5, Haiku 5.5, 2026-10-15, while watching a real issue-team run whose sidebar showed 768 then 354 tokens and `$0.00`.

**Receipt:** a streamed `/v1/chat/completions` request with a ~9,600-token system prompt returned `usage: {prompt_tokens: 4, completion_tokens: 4, total_tokens: 9650}`; the same through a non-streamed request and a repeat of the prompt. `session.db` agreed: a whole root session recorded `input_tokens = 2`, no `usage_json` on any item. In the proxy, `mapUsage()` (`dist/index.mjs:555`) sets `prompt_tokens: usage.input`, and Pi's `input` excludes `cacheRead` and `cacheWrite`.

**Why it matters:** Docker Agent builds its context size from the reported prompt and completion tokens (`SessionUsage`, `ContextLength: input + output`) and its proactive compaction decision from the same counters (`compaction.ShouldCompact(inputTokens, outputTokens, …, contextLimit, threshold)`). Reading the source at the installed commit, not testing it, this means the 90% trigger can never fire; only the after-the-fact overflow recovery remains, and that has not been exercised through the proxy. Cost shows `$0.00` for a separate reason (no price for `pi/…` models) and is not fixed by this.

**Fix:** `containers/pi-openai-proxy/patch-usage.ts` rewrites `mapUsage()` at build time so `prompt_tokens` is the whole prompt (`input + cacheRead + cacheWrite`) with `prompt_tokens_details.cached_tokens` and `cache_write_tokens`, which Docker Agent's Chat Completions adapter (`oaistream/adapter.go`) subtracts to recover the fresh part. Verified offline (the diff is that one function; 4 + 9000 + 642 in gives `prompt_tokens` 9646, so 9646 + 4 = 9650 = `total_tokens`; a second run of the patch step exits 1) and **end to end**, 2026-10-15, after rebuilding and recreating the proxy: the same ~9,650-token streamed request that returned `prompt_tokens: 4` now returns `prompt_tokens: 9646, completion_tokens: 4, total_tokens: 9650`, with `cache_write_tokens: 9642` on the first call and `cached_tokens: 9642` on repeats; the non-streamed response agrees. **Not yet watched:** a real run's counters accumulating in the sidebar, and compaction firing.

### A script tool result over 51,200 bytes is cut to its tail

**Observed:** Docker Agent v1.145.0, Linux, 2026-10-15, real run of
`j5 pr-reviewer review --pr 124` (native script tool, `--exec` not used).

**Receipt:** the tool returned 110,548 bytes. docker-agent replied with:

```text
Tool call result was too large (110548 bytes; limit 51200 bytes). The full result
is available in a file: /tmp/docker-agent-tool-results/<id>/tool-result-<n>.txt
Showing the last 2000 lines (up to 51200 bytes):
```

The model saw only the **end** of the output. The start, which held the metadata
and commit IDs, was gone, and the saved file was outside the agent's filesystem
allow-list, so a read of it failed with `outside the allowed directory`.

**Consequence:** a tool that can return a large result must page it itself, with
every page under the limit and a fingerprint tying the pages together. Put the
identifying facts in a small result, not at the start of a big one. A test with a
small fixture will not catch this. Also: `git diff --unified=N --stat` prints the
patch after the stat, so a stat command must not carry patch-implying options.

### `npm ci` through a symlinked `node_modules` empties the directory it points to

**Observed:** npm on this host, 2026-10-15, on a scratch project (not a real checkout).

**Receipt:** `node_modules` was a symlink to a sibling directory holding a marker file. After `npm ci`: `node_modules` was a real directory with the package installed, the marker file was gone, and the sibling directory was **empty**. The install followed the link, deleted the target's contents, and then replaced the link.

**Why it matters:** issue-team's first #558 run had the builder symlink the worktree's `node_modules` to the main checkout's, and a rerun was started in that worktree. The new "install dependencies" step would have emptied the main checkout's `node_modules`. It did not happen: the rerun read the issue, saw the PR already existed and stopped before any install (4 shell calls; the main checkout still had 359 entries, last modified before the run).

**Consequence:** never link a dependency directory between checkouts, and remove an existing link with `rm node_modules` (not `rm -r`, no trailing slash) before installing. The root's instructions say both. This is a prompt-level guard; a `tool_guard` hook that refuses `npm ci` while `node_modules` is a symlink would enforce it.

### `shell` kills a call after 30 seconds unless `timeout` is passed

**Observed:** Docker Agent v1.145.0, Linux, Sonnet 5.5 through the proxy, 2026-10-15.

**Receipt:** a native builder agent ran `sleep 32 && echo slept` twice:

```text
shell {"cmd": "sleep 32 && echo slept once", "timeout": null} -> Command timed out after 30s
shell {"cmd": "sleep 32 && echo slept once", "timeout": 60}   -> slept once
```

**Consequence:** an installs, build or test-suite command needs an explicit `timeout`,
so the issue-team instructions say to pass one. Each call also starts a fresh shell:
`cd` and variables do not carry over.

### Filesystem tools accept `~/…` paths, and `allow_list` expands `~`

**Observed:** v1.145.0, Haiku 5.5, 2026-10-15, `allow_list: [".",
"~/.agents/skills/j5-test-quality"]`.

**Receipt:**

```text
read_file ~/.agents/skills/j5-test-quality/workflows/generate.md -> read (first heading returned)
list_directory ~/.agents/skills/j5-test-quality/workflows        -> four workflow files
read_file ~/.agents/skills/the-craft/SKILL.md                    -> outside the allowed directories (., ~/.agents/skills/j5-test-quality)
```

`add_environment_info` named the working directory, OS and shell, not the home directory.

**Consequence:** an agent can be pointed at one directory under the home folder without
a shell to find `$HOME`, and cannot read its siblings.

### An unrestricted `search_files_content` from `/` can outlast the run

**Observed:** v1.145.0, 2026-10-15, a native tester with an unrestricted filesystem toolset.

**Receipt:** it called `search_files_content {"path": "/", …}` 5 seconds into its task and
had not returned when the run was killed at 700 seconds (`The tool call was canceled`).

**Consequence:** give every agent that can search an `allow_list`. A wrong skill path
then fails fast instead of becoming a filesystem scan.

### `--exec` rejects a tool that is not pre-approved

**Observed:** v1.145.0, 2026-10-15, pr-reviewer's `pr_comment`, which is not in `permissions.allow`.

**Receipt:** `j5 pr-reviewer review --pr 12 -- --exec --json` emitted a
`tool_call_confirmation` and the tool response was `The user rejected the tool call.`;
with `--safety autonomous` the same call posted. A run whose every tool is in
`permissions.allow` emitted no `tool_call_confirmation` events.

**Consequence:** list every tool an unattended run needs in `permissions.allow`. `deny`
still wins over `allow`.

### Opus 5.5 is rejected for the Pi proxy's subscription login

**Observed:** v1.145.0, proxy with pi-openai-proxy 4.9.5 and Pi 0.73.0, 2026-10-15.

**Receipt:** a native agent on `pi/claude-opus-5-5` failed on its first call:

```text
400 invalid_request_error: Claude Code 2.1.75 does not support this model;
version 2.1.280 or newer is required (error_code: claude_code_version_too_old)
```

`claude-sonnet-5-5` and `claude-haiku-5-5` through the same login work. So do
`claude-opus-4-7`, `claude-opus-4-6` and `claude-opus-4-5`: one request each, with and without
`reasoning_effort: high`, answered `OK` (2026-10-15).

**Fable too.** `claude-fable-5-1`, added to a second proxy's catalogue (it shared the live login
volume, so there was still one `auth.json`), failed the same way with
`version 2.1.251 or newer is required`.

**Consequence:** the proxy's `models.json` does not list Opus 5.5 or Fable 5.1. issue-team's
builders run on Sonnet 5.5 and its reviewer on Opus 4.7, the newest Opus that works.

**A newer Pi clears it (tried 2026-10-16).** The version in the error is the one Pi's Anthropic
client sends, `user-agent: claude-cli/<claudeCodeVersion>`, a constant in
`@earendil-works/pi-ai`. Reading that constant from the published packages: 0.75.0 to 0.84.4
send 2.1.75, 0.85.0 and 0.86.0 send 2.1.251, 1.0.0 to 1.3.0 send 2.1.280. A container built from
the fork's Pi 1.3.0 branch (a copy of the existing login in a throwaway volume, one request each)
answered `OK` on `claude-opus-5-5`, `claude-fable-5-1`, `claude-opus-5`, `claude-fable-5`,
`claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-5-5` and `claude-haiku-5-5`; Opus 5.5 also
passed a streamed request with usage and a tool call. Not tried: Fable on Pi 0.85.x (its floor
is 2.1.251, so it should work there; inference), a long run, or token refresh under Pi 1.x.
Details and the other forks reviewed: [proxy README](../../containers/pi-openai-proxy/README.md#upstream-status-and-the-fork).

### `docker agent debug config` takes `--flavor` but not `--model`

**Observed:** v1.145.0, 2026-10-15.

**Receipt:** `docker agent debug config team.yaml --model reviewer=pi/claude-opus-4-7` fails
(the usage line is `debug config <agent-file>|<registry-ref> [flavor...]`, and `--model` is
only a flag of `run`). `--flavor` is repeatable and applied in order:
`--flavor low --flavor reviewer-on-sonnet` printed the builders on `claude-haiku-5-5` and the
reviewer on `claude-sonnet-5-5`.

**Consequence:** the independence rule reads the real models with `debug config --flavor …`
(`launcher/src/team-models.ts`) and picks the reviewer's tier with a flavor, not `--model`. A
`--model` or `--flavor` after `--` would change the models unseen, so `j5` refuses both for a
team with a rule.

### `permissions.deny` globs block the spellings they name, and not a branch called `fix-foo`

**Observed:** v1.145.0, Haiku 5.5 through the proxy, 2026-10-15, with issue-team's real
`permissions` block and a `shell` toolset in a scratch repository with no remote.

**Receipt:** twelve commands, one `shell` call each, `--exec --json`:

```text
refused (Tool 'shell' is denied by permissions configuration.):
  git push --force origin main · git push -f origin main · git push origin +main
  git reset --hard HEAD · git commit … (the hook-bypass flag) · gh pr ready 1
  gh pr merge 1 · gh issue close 1 · sudo -n true
ran:
  git push -u origin fix-foo   (failed on its own: no such branch; not denied)
  echo hello · git log --oneline
```

No `tool_call_confirmation` events. The denied calls never reached the shell.

**Consequence:** `*git push* -f*` needs the space before `-f`; without it `fix-foo` would
match. Patterns match the command text, so they are defense in depth: a spelling the
globs do not name is not blocked.

### Read-only native filesystem tools can enforce a checkout boundary

**Observed:** Docker Agent v1.145.0 on Linux, Haiku 5.5 through the proxy above,
2026-10-15.

**Receipt:** a temporary native team used `tools: [read_file]` and
`allow_list: ["."]`. Running `docker agent run <team> --working-dir <allowed-root>
--exec --json --safety autonomous ...` attempted both an actual external
sentinel file and an actual symlink inside the root pointing to it:

```text
read_file(<external file>) -> isError: true, outside the allowed directories (.)
read_file(<allowed-root>/outside-link) -> isError: true, outside the allowed directories (.)
```

Neither response returned the sentinel contents. `debug toolsets --json` for
pr-reviewer separately listed only its configured read-only filesystem/git
tools, `pr_context` and `pr_diff`, with no shell or write tools.

**Consequence:** native tool restrictions remain active with autonomous tool
approval. This is not an OS sandbox or a secret filter: files inside the
allowed checkout are still readable, and prompt-injection resistance remains
a separate concern.

### `doctor` reports a credential as found when it is only set

**Observed:** v1.145.0, 2026-10-14.

**Receipt:** with `ANTHROPIC_API_KEY` set to a one-character value in `~/.config/cagent/.env` and unset in the shell, `docker agent doctor <team.yaml>` lists `anthropic  found  ANTHROPIC_API_KEY  config-env-file`. The same setup makes `--dry-run` exit 0, and a real `docker agent run … --exec` fails at the first model call:
```
model failed: error receiving from stream: Post "https://api.anthropic.com/v1/messages": net/http: invalid header field value for "X-Api-Key"
exit 1
```

**Consequence:** neither `doctor` nor a dry run (nor `validate:teams`) proves the key works. Only a real run does.

### A `harness: claude-code` agent gets none of docker-agent's agent extras

**Observed:** v1.145.0 with Claude Code 2.1.284, 2026-10-14.

**Receipt:** an agent with `harness: { type: claude-code, effort: low }` plus `instruction_file` (telling it to say a marker word first), a `type: script` tool `probe_tool` and `skills: [j5-test-quality]`. `debug config` accepts it and `debug toolsets` lists `probe_tool` and `read_skill`. A real `docker agent run full.yaml --exec` asked about all three answered `NONE` / `no` / `no`: no instruction, no script tool, no `read_skill`. (The agent's own report; consistent with the builder's tools in `workflows/issue-team/README.md`.)

**Consequence:** for a harness agent the task message is the only channel docker-agent provides. Prompts, tools and skills declared in `team.yaml` are silently dropped, and neither `debug` nor a dry run shows it.

`sub_agents` are dropped the same way: a harness `root` with `sub_agents: [helper]`, told to call `transfer_task` on `helper` or answer `NO SUCH TOOL`, answered `NO SUCH TOOL` (same date and versions). A harness agent delegates only through Claude Code's own sub-agent tool, and that works: a harness agent told to start one sub-agent that runs `issue-team-role tester | head -1` returned the first line of `roles/tester.md`, with the sub-agent's `agentId` and one tool use in the output. Sub-agents see the launcher's `PATH` too.

The conversation does carry over: two `--exec` turns of one harness agent with the same `--session <id>` (and `-s <scratch session.db>`); turn 1 "Remember the word KIWI", turn 2 "Which word …?" answered `KIWI`. An agent that stops to ask the user can be answered in a later turn.

**`harness.model` does apply.** With `harness: { type: claude-code, model: claude-haiku-4-5 }` the run's Claude Code transcript (`~/.claude/projects/<cwd>/*.jsonl`) records `claude-haiku-4-5-20251001`; without it, the user's own Claude Code default (`claude-opus-5-5` here). Checked on the real team files too: issue-team `root` → `claude-sonnet-5-5`; test-quality `writer --flavor low` → `claude-haiku-4-5-20251001` (2026-10-14). A model not set in `team.yaml` is whatever the user's Claude Code is set to.

**When the harness itself cannot run,** docker-agent prints one line and exits 1. Seen with the Claude session limit (v1.145.0, Claude Code 2.1.284, 2026-10-14):
```
You've hit your session limit · resets 1pm (America/Chicago)harness claude-code failed: wait: exit status 1
```
`j5`'s queue stops on `harness … failed` with a non-zero exit (`AGENT_INFRASTRUCTURE_FAILURE_PATTERN` in `launcher/src/queue.ts`) instead of failing every remaining issue in seconds. If an upgrade rewords this line, that stop silently becomes one fast failure per issue: re-check it.

**What does reach it:** the docker-agent process's `PATH`. With a team's `bin/` prepended (as `j5` does), the harness ran `test-quality-prescreen` by bare name through its own shell tool and got the helper's real output and exit code.

### `--worktree` does not move a harness agent into the worktree

**Observed:** v1.145.0 with Claude Code 2.1.284, 2026-10-14.

**Receipt:** from a scratch clone on `main`, a harness agent asked to run `pwd; git branch --show-current`:
```
docker agent run plain.yaml --worktree=probe-cwd --worktree-base origin/main --exec "…"
# → <the clone>  main            (the worktree was created, but Claude Code runs in the clone)
docker agent run plain.yaml --working-dir ~/.cagent/worktrees/probe-cwd --exec "…"
# → ~/.cagent/worktrees/probe-cwd  worktree-probe-cwd
```
The TUI header shows the worktree path either way. Seen in a real `work-issue` run too: the agent's first `pwd` printed the user's checkout, and Claude Code reset its shell to the checkout after every `cd` into the worktree.

**Consequence:** with `--worktree` / `--worktree-pr`, a harness agent's edits and commits land in the user's checkout unless it `cd`s into the worktree on every command. `--working-dir <worktree>` puts it in the worktree.

**Resuming does not remember it:** turn 1 with `-s <scratch db> --session <id> --working-dir <worktree>` printed the worktree; turn 2 with the same `--session <id>` and no `--working-dir`, started from the clone, printed the clone. Start a resumed session inside the worktree, or pass `--working-dir` again.

**Mitigation:** `j5` creates worktrees itself, beside the checkout, and starts docker-agent in them with `--working-dir` (`launcher/src/plan.ts`).

### `debug config` is the canonical-config printer

`docker agent debug config <team.yaml> [--flavor X]` prints the fully resolved configuration (instruction files inlined, defaults filled, flavor applied) and exits non-zero with a parse error on an invalid file. It is the fastest validity check there is, and diffing two of its outputs is how you see what a change really does.

## Skills

### A `description: |` block scalar loads as the literal `|`

**Observed:** v1.145.0, 2026-10-14.

**Receipt:** `docker agent debug skills workflows/issue-team/team.yaml` lists `+ test-quality-with-ai - |` for tester and reviewer; the skill's frontmatter has `description: |` followed by an indented block.

**Consequence:** the skill is never matched from its description. Agents that need it must name it explicitly. Write skill descriptions as one-line scalars.

**Fix, verified:** a one-line, double-quoted `description: "..."` loads in full without the quotes (`docker agent debug skills` on `skills/j5-test-quality`, 2026-10-14). Quote it when the text contains `: `.

### Symlinked skill directories are skipped

**Observed:** v1.145.0 source, commit 502549c (`pkg/skills/local.go`): the flat scan skips entries where `isSymlink` is true, and the recursive scan uses `filepath.WalkDir`, which does not follow links. Not yet exercised with a real symlink.

**Consequence:** installing a skill by linking `~/.agents/skills/<name>` to a checkout does not work; the skill must be copied, and re-copied after changes.

### A skill that is not installed is silently dropped

**Observed:** v1.145.0, 2026-10-14.

**Receipt:** with `skills: [j5-test-quality]` in `workflows/issue-team/team.yaml` and no `~/.agents/skills/j5-test-quality`, `docker agent debug skills workflows/issue-team/team.yaml` prints `No skills for tester` / `No skills for reviewer` and exits 0; `docker agent run ... --agent tester --dry-run --exec` also exits 0.

**Consequence:** an agent whose instructions depend on a skill runs without it, and neither a dry run nor `validate:teams` notices.

**Mitigation:** run `bun scripts/install.ts` after pulling changes that add or rename a skill; check with `docker agent debug skills <team.yaml>`.

### Local skills get `read_skill`, but no `read_skill_file`

**Observed:** v1.145.0, 2026-10-14.

**Receipt:** `docker agent debug toolsets` for an agent with `skills: true`, `[j5-test-quality]`, `[local, j5-test-quality]` or `[local]` (the skill installed in `~/.agents/skills`) lists only `read_skill` in every case. In a real run (2026-10-15, Sonnet 5.5 through the proxy) the agent got the 6 KB `SKILL.md` from `read_skill {"name": "j5-test-quality"}`, then `read_skill {"name": "j5-test-quality/workflows/generate.md"}` returned `skill "…" not found` and it was never offered another tool. The source at the installed commit (`docker agent version` → 502549c) explains it: `read_skill_file` is registered only when some loaded skill has more than one entry in `Skill.Files` (`pkg/tools/builtin/skills/skills.go`, `hasFiles()`), and `Files` is assigned only for remote-index skills (`pkg/skills/remote.go`); `pkg/skills/local.go` sets `FilePath` and `BaseDir` and never `Files`. The docs page tracks `main` and describes `read_skill_file` for `SKILL.md` directories without this limit.

**Consequence:** instructions must point at a local skill's other files by path. The filesystem tools expand a leading `~/` on every OS (`pkg/tools/builtin/filesystem/filesystem_paths.go`), so `read_file ~/.agents/skills/<name>/workflows/x.md` works on Windows too. issue-team's tester and reviewer do this, and `skills:` is not set for them: it would add the skill's description to the prompt and `read_skill` for `SKILL.md`, but no way to reach the workflow files.

**GitHub skill sources are not in v1.145.0, despite the docs.** `skills: [https://github.com/vx-daniel/number-5/tree/main/skills]` (2026-10-15, public repo, skill present on `main`) gave the agent no skill tools. The debug log (`-d --log-file`) shows why: `Fetching remote skills index url=https://github.com/…/tree/main/skills/.well-known/skills/index.json`, then `Remote skills index returned non-OK status … status=404`. In this version any `https://` entry is a remote *index* URL (`<url>/.well-known/skills/index.json`, entries with a `files` list, which is what lets remote skills get `read_skill_file`); the tree-URL form is documented on `main` only. `debug skills` does not fetch remote sources, so it reported "No skills" without saying why.

**Search paths** (same source): `~/.codex/skills` (recursive), `~/.claude/skills` (flat), `~/.agents/skills` (recursive), then `.claude/skills` in the working directory and `.github/skills` / `.agents/skills` in each directory from the git root down to it. All built with `filepath.Join`, so identical on every OS.

**`instruction_file` accepts only a relative path inside the config directory.** `../skills/x.md`, `/abs/x.md` and `~/x.md` are all rejected at load: `agent "root": instruction_file "../skills/skill.md" must be a local relative path inside the config directory` (`~/…` fails earlier, with `openat ~/…: no such file`). A team therefore cannot inject a skill file from `~/.agents/skills` or from `skills/` in place; issue-team keeps copies under `instructions/skill/` and a test (`test/skill-instructions.test.ts`) fails when a copy differs from its source. Receipt, 2026-10-15, v1.145.0, `debug config` on a scratch team.

## Platforms

### The shell tool and script tools use the user's shell, not bash

**Observed:** v1.145.0 source, commit 502549c (`pkg/shellpath/shellpath.go`, `pkg/tools/builtin/shell/script_shell.go`).

- Unix: `$SHELL -c <cmd>`, else `/bin/sh -c`. On a default macOS install that is zsh.
- Windows: `pwsh.exe`, else `powershell.exe` (`-NoProfile -NonInteractive -Command`), else `cmd.exe /C`.
- Script-tool arguments reach the command as **environment variables**; `cmd:` is passed to that shell as-is.

**Consequence:** `cmd: helper "$pr"` works under bash and zsh only. Under PowerShell `$pr` is an unset local variable (`$env:pr` is the environment variable); under cmd.exe it is `%pr%`. The portable form is a bare `cmd: helper` with the helper reading its arguments from its environment.

The data directory, and with it `worktrees/`, is `<home>/.cagent` on every OS (`pkg/paths/paths.go`).

## Unverified

Carried over from `workflows/issue-team/README.md` ("Known limits") or reported without a receipt in this repository. Confirm one with a receipt, then move it up.

- **The docs on docker.github.io track `main`**, not the release, and document flags v1.145.0 lacks (e.g. `--last`). Trust `docker agent <command> --help` over the website.
- **docker-agent names PR worktrees `pr-<number>`** without the repository name, so the same PR number in two repositories collides under `~/.cagent/worktrees/`. `j5` no longer uses `--worktree-pr`; it creates `<repo>-pr-<n>` beside the checkout.
- **Worktrees from `--exec` runs are never removed automatically.** Clean up with `git worktree list` / `git worktree remove <path>`.
- **`permissions.deny` rules cover docker-agent's own shell tool only.** A `harness: claude-code` agent runs Claude Code's tools, outside those rules.
- **Script tools resolve commands through the docker-agent process's `PATH`.** A helper that is not on `PATH` fails with "command not found" at call time, not at startup. `j5` prepends each team's `path:` directories.
- **`--worktree`, `--worktree-pr` and `--sandbox` cannot be combined.**
- **A Sonnet 5.5 `edit_file` call through the proxy once arrived as invalid JSON.** Seen 2026-10-15 in issue-team's first real run (session `7acf06c5…`, tester): `{"path": "…", "edits": [{"oldText">: "", "newText": ""}]}`, answered `Error calling tool: failed to parse edit_file arguments: invalid character '>' after object key`. The tester then edited with `python3` heredocs; the builder never called `edit_file` and made six edits through `shell`. One failure, not a rate, and `edit_file` worked in an earlier probe (same model and proxy). Not known whether the model, the proxy's tool-schema translation or the stream caused it.
- **On Windows, a multi-line message cannot pass through a `.cmd` / `.bat` `docker`.** cmd.exe ends a command at the first newline. Seen in CI (windows-latest, 2026-10-14): the launch test's fake `docker.cmd` exited 1 once messages became whole prompts, where it had passed with a one-line message; the test now uses a compiled fake. Real Docker is `docker.exe`, which `j5` spawns without cmd.exe, so this should not affect real runs; not yet run on Windows.
- **A script-tool argument named `path` would replace `PATH` on Windows.** Inferred, not run: docker-agent passes script-tool arguments as environment variables (`script_shell.go`), and Windows environment variable names are case-insensitive. The teams here avoid the name (`test_prescreen` takes `target`).
