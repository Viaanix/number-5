# number-5

*Need input.*

Agentic workflows ("teams") built on [docker-agent](https://github.com/docker/docker-agent), and `j5`, one launcher for all of them.

| Team | What it does |
|---|---|
| [issue-team](workflows/issue-team/README.md) | GitHub issue → pull request → review follow-up → post-merge closeout, in any repository |
| [test-quality](workflows/test-quality/README.md) | Audit, review, write or fix tests with the `j5-test-quality` skill, in the current checkout |

## Quick start

Prerequisites: Docker with the `docker agent` plugin (v1.145.0), [Bun](https://bun.sh), and `claude` logged in to a Claude subscription: every agent is Claude Code (`harness: claude-code`), so no API key is needed. issue-team also needs `gh` logged in; see each team's README.

```bash
bun scripts/install.ts      # link ~/number-5, add `j5` to your shell, install skills, bun install
# open a new terminal (bash, zsh, or PowerShell on Windows), then:
j5 list
cd ~/code/some-repo && j5 issue-team work-issue --issue 123
j5                         # or pick everything interactively
```

## Docs

- [docs/launcher.md](docs/launcher.md) — `j5` options and the `workflow.yaml` manifest
- [docs/new-team.md](docs/new-team.md) — adding a team or experiment
- [docs/docker-agent/](docs/README.md) — reference, patterns and gotchas

## Development

`bun run check` runs typecheck, oxlint, oxfmt, shellcheck, the bun tests and team validation. CI runs all of it on Linux; macOS runs everything except team validation; Windows runs typecheck, oxlint, oxfmt and the bun tests (`.github/workflows/check.yml`). Details in [CLAUDE.md](CLAUDE.md).
