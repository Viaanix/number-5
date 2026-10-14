# docker-agent-workflows

Agentic workflows ("teams") built on [docker-agent](https://github.com/docker/docker-agent), and `daw`, one launcher for all of them.

| Team | What it does |
|---|---|
| [issue-team](issue-team/README.md) | GitHub issue → pull request → review follow-up → post-merge closeout, in any repository |

## Quick start

Prerequisites: Docker with the `docker agent` plugin (v1.145.0), [Bun](https://bun.sh), plus whatever each team needs (issue-team: `gh` and `claude` logged in; see its README).

```bash
scripts/install.sh          # symlink ~/docker-agent-workflows, alias `daw`, bun install
source ~/.bash_aliases
daw list
cd ~/code/some-repo && daw issue-team work-issue --issue 123
daw                         # or pick everything interactively
```

## Docs

- [docs/launcher.md](docs/launcher.md) — `daw` options and the `workflow.yaml` manifest
- [docs/new-team.md](docs/new-team.md) — adding a team or experiment
- [docs/docker-agent/](docs/README.md) — reference, patterns and gotchas

## Development

`bun run check` runs typecheck, oxlint, oxfmt, shellcheck, bun tests, bats tests and team validation. Details in [CLAUDE.md](CLAUDE.md).
