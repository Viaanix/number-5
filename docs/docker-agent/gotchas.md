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
tools and `pr_context`, with no shell or write tools.

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

**Receipt:** `docker agent debug toolsets` for an agent with `skills: [j5-test-quality]` (installed in `~/.agents/skills`) lists only `read_skill`. In the source, `read_skill_file` is offered only when a skill has supporting files listed (`pkg/tools/builtin/skills/skills.go`), which local skills never do.

**Consequence:** instructions must point at a local skill's other files by path. The filesystem tools expand a leading `~/` on every OS (`pkg/tools/builtin/filesystem/filesystem_paths.go`), so `read_file ~/.agents/skills/<name>/workflows/x.md` works on Windows too.

**Search paths** (same source): `~/.codex/skills` (recursive), `~/.claude/skills` (flat), `~/.agents/skills` (recursive), then `.claude/skills` in the working directory and `.github/skills` / `.agents/skills` in each directory from the git root down to it. All built with `filepath.Join`, so identical on every OS.

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
- **On Windows, a multi-line message cannot pass through a `.cmd` / `.bat` `docker`.** cmd.exe ends a command at the first newline. Seen in CI (windows-latest, 2026-10-14): the launch test's fake `docker.cmd` exited 1 once messages became whole prompts, where it had passed with a one-line message; the test now uses a compiled fake. Real Docker is `docker.exe`, which `j5` spawns without cmd.exe, so this should not affect real runs; not yet run on Windows.
- **A script-tool argument named `path` would replace `PATH` on Windows.** Inferred, not run: docker-agent passes script-tool arguments as environment variables (`script_shell.go`), and Windows environment variable names are case-insensitive. The teams here avoid the name (`test_prescreen` takes `target`).
