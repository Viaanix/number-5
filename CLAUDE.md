# number-5

Agentic workflows ("teams") built on [docker-agent](https://github.com/docker/docker-agent), plus `j5`, a launcher that starts any team against any project checkout.

## Layout

| Path | What |
|---|---|
| `workflows/<team>/` | One team per directory under `workflows/` (the launcher scans only there): `team.yaml` (native docker-agent models/tools), `workflow.yaml` (launcher manifest), `helpers/` + `bin/`, `instructions/`. issue-team (sub-agents, shell, typed tools), pr-reviewer and test-quality (the `j5-test-quality` skill; read-only auditor/reviewer, writer, fixer) are all native teams on the local Pi proxy; no team uses a Claude Code harness any more. The manifest message carries the task parameters; `instruction_file` carries each agent's procedure |
| `launcher/src/` | The `j5` CLI (Bun + TypeScript). `cli.ts` is the entry (it has the `#!/usr/bin/env bun` line the package's `bin` needs) and gathers choices; `plan.ts` builds the git steps and docker-agent command and has no side effects; `run.ts` executes plans (single runs, and queue runs: one unattended run per item); `queue.ts` is the queue's pure logic (parsing, outcomes from the `RESULT:` line, summary); `setup.ts` is `j5 setup` (tool checks, skills, the proxy token and start, with the machine injected so tests need no Docker); `skills.ts` installs the skills, shared with `scripts/install.ts`; `package-info.ts` reads the installed version; `independence.ts` (model tiers, the reviewer ladder), `team-models.ts` (real models via `docker agent debug config`) and `reviewer-flavor.ts` (the launch-time step) keep a team's reviewer off the builders' model class. Also the code team helpers share (`team-helper.ts`, `change-diff.ts`, `test-prescreen.ts`), so no team imports another |
| `launcher/test/` | bun:test tests; real temporary git repositories, no module mocks |
| `skills/` | Agent skills shipped with the teams (`j5-test-quality`); the installer copies them to `~/.agents/skills/` |
| `bin/j5` | Shim the alias points at, for a clone |
| `scripts/` | `install.ts` (link + shell alias/function, all OSes; for a clone), `lint-shell.sh`, `validate-teams.ts` |
| `package.json` | Published as `@viaanix/number-5` to GitHub Packages. `files` is the allow-list of what ships (`launcher/src`, `workflows` minus tests, `skills`, `containers/pi-openai-proxy`); `bin.j5` is `launcher/src/cli.ts`. Release flow in [docs/packaging.md](docs/packaging.md) |
| `tests/` | bun:test tests for `scripts/` |
| `docs/` | docker-agent knowledge (reference, patterns, gotchas), launcher and new-team guides |
| `containers/` | Pinned model/runtime containers. `pi-openai-proxy/` exposes subscription-backed model access for native agents and mounts the versioned current-model catalogue separately from its login volume |
| `vite.config.ts` | Vite+ configuration: the formatter (`fmt`), the linter (`lint`, type-aware) and the pre-commit check on staged files (`staged`) |
| `.vite-hooks/` | Git hooks; `pre-commit` runs `vp staged`. `.vite-hooks/_/` is the dispatcher `vp config` generates (git's `core.hooksPath` points there) |

## Verification

```bash
bun install          # once
bun run check        # everything below, in order; must exit 0
bun run typecheck    # tsc --noEmit
bun run lint         # vp lint --deny-warnings (Oxlint through Vite+, `lint` in vite.config.ts), type-aware; lint:fix applies fixes and formats
bun run format:check # vp fmt --check (Oxfmt through Vite+, `fmt` in vite.config.ts); `bun run format` writes
bun run lint:shell   # shellcheck on every shell script, found by shebang and *.sh (Linux/macOS)
bun run test         # bun test --timeout=30000 (launcher; spawn-heavy tests take seconds on Windows)
bun run validate:teams   # manifests, agents, configs, flavors, dry runs against the installed docker-agent
```

`check` passing is necessary, not sufficient. For a launcher change, run the affected path: `bin/j5 <team> <entrypoint> … --print`, then `… -- --dry-run --exec` in a scratch repository. For a team change, `validate:teams` plus a real run on a throwaway repository.

Every commit runs `vp check --fix` on the staged files (format, lint, type checks) through the pre-commit hook, and may rewrite them. It is a fast subset of `check`, not a replacement: it skips the shell lint, the tests and team validation.

Native pr-reviewer validation needs a non-empty `PI_PROXY_AUTH_TOKEN`; use the running proxy's token for real runs. For model-free CI/dry-run validation only, `PI_PROXY_AUTH_TOKEN=validation-only-no-model-calls bun run check` needs no proxy or provider login. The tests also require `pwsh` on PATH for PowerShell quoting checks.

## Conventions

- Type-aware lint is on (`lint.options.typeAware` in vite.config.ts). When a finding comes from a wrong third-party type, fix the type you read it through (see `isTerminal` in `launcher/src/cli.ts`) instead of disabling the rule.
- Formatting: `vp fmt` covers TS/JS/JSON only. Markdown and YAML are excluded on purpose (`fmt.ignorePatterns`): agent prompts (`workflow.yaml` messages, `instructions/*.md`) and `team.yaml` are hand-formatted model input.
- Verbose names, no abbreviations; comments carry *why*. Named constants instead of magic values.
- Tests: say what bug each test catches. No `mock.module`; inject paths and use real git repositories (`launcher/test/fixtures.ts`).
- Imports from outside `launcher/` into it use the `package.json` `imports` aliases: `#launcher/<file>.ts` for `launcher/src/`, `#launcher-test/<file>.ts` for `launcher/test/`. Files inside `launcher/` import each other relatively. The `#` prefix, not `@`, keeps the formatter from sorting these among npm packages. An alias import is still code outside the team directory: a sandboxed run mounts only the team directory, so a helper that uses one cannot run there (#14).
- Shell: `#!/usr/bin/env bash`, `set -euo pipefail`, shellcheck-clean at style level without inline disables.
- A docker-agent behavior claim in `docs/` carries a receipt (command + output + version), or goes under "Unverified" in `docs/docker-agent/gotchas.md`. Something surprised you? Add it there.
- Installed docker-agent: v1.145.0. After upgrading, re-run the receipts in `docs/docker-agent/gotchas.md`.

## Known state

- `docker agent alias issue-team` points at a copy of `workflows/issue-team/` elsewhere (`~/dopamine911/repo/team`), byte-identical as of 2026-10-14 before this repo added `workflow.yaml`, the `low` flavor, TypeScript helpers with sh/.cmd launchers and bare script-tool `cmd:` lines, and OS-neutral temp paths in the prompts. Edits here do not reach that alias.

## The generated Vite+ section

Vite+ writes the section between the `VITE PLUS` markers below and replaces it whenever it updates agent instructions, so corrections go here, not inside it. Where it disagrees with this file, this file wins:

- **Tests run on `bun test`** (`bun run test`). `vp test` runs Vitest instead, and every test file here fails under it (18 of 18, 2026-10-15).
- **The gate is `bun run check`.** `vp check` covers only format, lint and type checks.
- **Install with `bun install`**, as CI does (`bun install --frozen-lockfile`).

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->
