![number-5: a robot at a workbench, a pipeline from Issue to Agent, Plan, Code, PR and Merge, and the words "Need input."](docs/assets/number-5-banner.jpg)

# number-5

*Need input.*

Agentic workflows ("teams") built on [docker-agent](https://github.com/docker/docker-agent), and `j5`, one launcher for all of them.

| Team | What it does |
|---|---|
| [issue-team](workflows/issue-team/README.md) | GitHub issue → pull request, in any repository: ready when review and verification pass, a draft when they do not |
| [test-quality](workflows/test-quality/README.md) | Audit, review, write or fix tests with the `j5-test-quality` skill, in the current checkout |
| [pr-reviewer](workflows/pr-reviewer/README.md) | Native PR review with Claude Sonnet 5.5 through the local proxy; returns a report and posts it as one PR comment |
| [triage](workflows/triage/README.md) | Decide whether a GitHub issue can be worked on as written: label it ready, needs-info or needs-decision, or split it into sub-issues |

## Quick start

**New to this, or on Windows or macOS?** Follow the step-by-step [Getting started guide](docs/getting-started.md): every tool, token and command, for Linux, macOS and Windows.

Prerequisites: Docker with the `docker agent` plugin (v1.145.0), [Bun](https://bun.sh), `git` and `gh`. Every team uses the logged-in [proxy container](containers/pi-openai-proxy/README.md) and its local `PI_PROXY_AUTH_TOKEN`, not an Anthropic API key. `j5 setup` checks all of this.

**Install the package** (teammates; needs a one-time registry token, see [docs/packaging.md](docs/packaging.md#install-teammates)):

```bash
bun add -g @viaanix/number-5
j5 setup                    # checks your tools, installs the skills
j5 setup --proxy --login    # optional: start the local proxy and log it in
j5 list
cd ~/code/some-repo && j5 issue-team work-issue --issue 123
```

**From a clone** (changing number-5 itself):

```bash
bun scripts/install.ts      # link ~/number-5, add `j5` to your shell, install skills, bun install
# open a new terminal (bash, zsh, or PowerShell on Windows), then:
j5 list
cd ~/code/some-repo && j5 issue-team work-issue --issue 123
j5                         # or pick everything interactively
```

## Docs

- [docs/launcher.md](docs/launcher.md) — `j5` options and the `workflow.yaml` manifest
- [docs/packaging.md](docs/packaging.md) — installing number-5 as a package, `j5 setup`, releasing
- [docs/new-team.md](docs/new-team.md) — adding a team or experiment
- [docs/docker-agent/](docs/README.md) — reference, patterns and gotchas
- [containers/pi-openai-proxy/](containers/pi-openai-proxy/README.md) — pinned subscription-backed model endpoint for native Docker Agent agents

## Development

`bun run check` runs typecheck, lint and format checks (Oxlint and Oxfmt through [Vite+](https://viteplus.dev), configured in `vite.config.ts`), shellcheck, the bun tests and team validation. CI runs all of it on Linux; macOS runs everything except team validation; Windows runs typecheck, lint, format and the bun tests (`.github/workflows/check.yml`). Each commit also runs `vp check --fix` on the staged files through a pre-commit hook. Details in [CLAUDE.md](CLAUDE.md).
