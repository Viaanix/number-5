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

### `debug config` is the canonical-config printer

`docker agent debug config <team.yaml> [--flavor X]` prints the fully resolved configuration (instruction files inlined, defaults filled, flavor applied) and exits non-zero with a parse error on an invalid file. It is the fastest validity check there is, and diffing two of its outputs is how you see what a change really does.

## Unverified

Carried over from `issue-team/README.md` ("Known limits") or reported without a receipt in this repository. Confirm one with a receipt, then move it up.

- **Skill frontmatter is parsed line by line.** A `description: |` block scalar loads as the literal `|`, so the skill is never matched automatically; name it explicitly in the agent's instructions.
- **Local skills get no `read_skill_file` tool.** Instructions must point at the skill's files by path (e.g. `~/.agents/skills/<name>/...`).
- **The docs on docker.github.io track `main`**, not the release, and document flags v1.145.0 lacks (e.g. `--last`). Trust `docker agent <command> --help` over the website.
- **PR worktrees are named `pr-<number>`** without the repository name, so the same PR number in two repositories collides under `~/.cagent/worktrees/`. `daw` refuses a `pr-<n>` worktree whose `origin` is another repository.
- **Worktrees from `--exec` runs are never removed automatically.** Clean up with `git worktree list` / `git worktree remove <path>`.
- **`permissions.deny` rules cover docker-agent's own shell tool only.** A `harness: claude-code` agent runs Claude Code's tools, outside those rules.
- **Script tools resolve commands through the docker-agent process's `PATH`.** A helper that is not on `PATH` fails with "command not found" at call time, not at startup. `daw` prepends each team's `path:` directories.
- **`--worktree`, `--worktree-pr` and `--sandbox` cannot be combined.**
