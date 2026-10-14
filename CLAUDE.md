# number-5

Agentic workflows ("teams") built on [docker-agent](https://github.com/docker/docker-agent), plus `j5`, a launcher that starts any team against any project checkout.

## Layout

| Path | What |
|---|---|
| `workflows/<team>/` | One team per directory under `workflows/` (the launcher scans only there): `team.yaml` (docker-agent), `workflow.yaml` (launcher manifest), `instructions/`, `bin/`. `workflows/issue-team/` is the reference team; `workflows/test-quality/` runs the `j5-test-quality` skill |
| `launcher/src/` | The `j5` CLI (Bun + TypeScript). `cli.ts` is the entry; `plan.ts` builds the docker-agent command and has no side effects. Also the code team helpers share (`team-helper.ts`, `change-diff.ts`, `test-prescreen.ts`), so no team imports another |
| `launcher/test/` | bun:test tests; real temporary git repositories, no module mocks |
| `skills/` | Agent skills shipped with the teams (`j5-test-quality`); the installer copies them to `~/.agents/skills/` |
| `bin/j5` | Shim the alias points at |
| `scripts/` | `install.ts` (link + shell alias/function, all OSes), `lint-shell.sh`, `validate-teams.ts` |
| `tests/` | bun:test tests for `scripts/` |
| `docs/` | docker-agent knowledge (reference, patterns, gotchas), launcher and new-team guides |

## Verification

```bash
bun install          # once
bun run check        # everything below, in order; must exit 0
bun run typecheck    # tsc --noEmit
bun run lint         # oxlint --deny-warnings (.oxlintrc.json), type-aware via oxlint-tsgolint; lint:fix applies fixes and formats
bun run format:check # oxfmt --check (.oxfmtrc.json); `bun run format` writes
bun run lint:shell   # shellcheck on every shell script, found by shebang and *.sh (Linux/macOS)
bun run test         # bun test --timeout=30000 (launcher; spawn-heavy tests take seconds on Windows)
bun run validate:teams   # manifests, agents, configs, flavors, dry runs against the installed docker-agent
```

`check` passing is necessary, not sufficient. For a launcher change, run the affected path: `bin/j5 <team> <entrypoint> … --print`, then `… -- --dry-run --exec` in a scratch repository. For a team change, `validate:teams` plus a real run on a throwaway repository.

## Conventions

- Type-aware lint is on (`options.typeAware`). When a finding comes from a wrong third-party type, fix the type you read it through (see `isTerminal` in `launcher/src/cli.ts`) instead of disabling the rule.
- Formatting: oxfmt covers TS/JS/JSON only. Markdown and YAML are excluded on purpose: agent prompts (`instructions/*.md`) and `team.yaml` are hand-formatted model input.
- Verbose names, no abbreviations; comments carry *why*. Named constants instead of magic values.
- Tests: say what bug each test catches. No `mock.module`; inject paths and use real git repositories (`launcher/test/fixtures.ts`).
- Shell: `#!/usr/bin/env bash`, `set -euo pipefail`, shellcheck-clean at style level without inline disables.
- A docker-agent behavior claim in `docs/` carries a receipt (command + output + version), or goes under "Unverified" in `docs/docker-agent/gotchas.md`. Something surprised you? Add it there.
- Installed docker-agent: v1.145.0. After upgrading, re-run the receipts in `docs/docker-agent/gotchas.md`.

## Known state

- `docker agent alias issue-team` points at a copy of `workflows/issue-team/` elsewhere (`~/dopamine911/repo/team`), byte-identical as of 2026-10-14 before this repo added `workflow.yaml`, the `low` flavor, TypeScript helpers with sh/.cmd launchers and bare script-tool `cmd:` lines, and OS-neutral temp paths in the prompts. Edits here do not reach that alias.
