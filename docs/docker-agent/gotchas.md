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

**Mitigation:** `daw` reads the flavor names from `team.yaml` and rejects anything else (`launcher/src/parameters.ts`, `describeInvalidEffort`). Do the same check in any other wrapper.

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
docker agent run issue-team/team.yaml --agent closer --dry-run --exec x
# → Dry run mode enabled. Agent initialized but will not execute.   (exit 0; there is no agent "closer")
```

**Consequence:** a dry run is not proof that `-a <name>` is right.

**Mitigation:** `daw` and `validate:teams` check every entry point's agent against the `agents:` keys in `team.yaml`.

### `run --dry-run --worktree=<name>` creates no worktree

**Observed:** v1.145.0, 2026-10-14.

**Receipt:** in a scratch repository, `docker agent run team.yaml --dry-run --exec --worktree=probe "x"` exits 0; `git worktree list` and `ls ~/.cagent/worktrees` are unchanged.

**Consequence (useful):** a dry run is a safe way to check that a full command line parses, worktree flags included.

### `run --dry-run` still requires the provider's API key to be set

**Observed:** v1.145.0, 2026-10-14.

**Receipt:**
```bash
env -u ANTHROPIC_API_KEY docker agent run issue-team/team.yaml --config-dir <empty dir> --dry-run --exec x
# → "Welcome to docker agent!" setup flow, exit 255 (in CI: "The following environment variables must be set: ANTHROPIC_API_KEY")
ANTHROPIC_API_KEY=placeholder docker agent run issue-team/team.yaml --config-dir <empty dir> --dry-run --exec x
# → Dry run mode enabled. Agent initialized but will not execute.   (exit 0)
```

**Consequence:** a dry run checks that the key is present, not that it is valid. CI needs a value even though no model is called.

**Mitigation:** `.github/workflows/check.yml` sets a placeholder `ANTHROPIC_API_KEY` for `bun run check`.

### `debug config` is the canonical-config printer

`docker agent debug config <team.yaml> [--flavor X]` prints the fully resolved configuration (instruction files inlined, defaults filled, flavor applied) and exits non-zero with a parse error on an invalid file. It is the fastest validity check there is, and diffing two of its outputs is how you see what a change really does.

## Skills

### A `description: |` block scalar loads as the literal `|`

**Observed:** v1.145.0, 2026-10-14.

**Receipt:** `docker agent debug skills issue-team/team.yaml` lists `+ test-quality-with-ai - |` for tester and reviewer; the skill's frontmatter has `description: |` followed by an indented block.

**Consequence:** the skill is never matched from its description. Agents that need it must name it explicitly. Write skill descriptions as one-line scalars.

**Fix, verified:** a one-line, double-quoted `description: "..."` loads in full without the quotes (`docker agent debug skills` on `skills/j5-test-quality`, 2026-10-14). Quote it when the text contains `: `.

### Symlinked skill directories are skipped

**Observed:** v1.145.0 source, commit 502549c (`pkg/skills/local.go`): the flat scan skips entries where `isSymlink` is true, and the recursive scan uses `filepath.WalkDir`, which does not follow links. Not yet exercised with a real symlink.

**Consequence:** installing a skill by linking `~/.agents/skills/<name>` to a checkout does not work; the skill must be copied, and re-copied after changes.

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

Carried over from `issue-team/README.md` ("Known limits") or reported without a receipt in this repository. Confirm one with a receipt, then move it up.

- **Local skills get no `read_skill_file` tool.** Instructions must point at the skill's files by path (e.g. `~/.agents/skills/<name>/...`).
- **The docs on docker.github.io track `main`**, not the release, and document flags v1.145.0 lacks (e.g. `--last`). Trust `docker agent <command> --help` over the website.
- **PR worktrees are named `pr-<number>`** without the repository name, so the same PR number in two repositories collides under `~/.cagent/worktrees/`. `daw` refuses a `pr-<n>` worktree whose `origin` is another repository.
- **Worktrees from `--exec` runs are never removed automatically.** Clean up with `git worktree list` / `git worktree remove <path>`.
- **`permissions.deny` rules cover docker-agent's own shell tool only.** A `harness: claude-code` agent runs Claude Code's tools, outside those rules.
- **Script tools resolve commands through the docker-agent process's `PATH`.** A helper that is not on `PATH` fails with "command not found" at call time, not at startup. `daw` prepends each team's `path:` directories.
- **`--worktree`, `--worktree-pr` and `--sandbox` cannot be combined.**
