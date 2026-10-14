# docker-agent quick reference

The commands and config keys this repository relies on, as of **docker-agent v1.145.0** (`docker agent version`). For anything not here, `docker agent <command> --help` is authoritative; the website tracks `main` (see [gotchas](gotchas.md#unverified)).

## Commands we use

| Command | What for |
|---|---|
| `docker agent run <team.yaml> [-a agent] [message]` | Run a team, interactive TUI by default |
| `… --exec` | Run without the TUI (headless) |
| `… --dry-run` | Load and initialize the team, call no model. Does not create worktrees |
| `… --flavor <name>` | Apply a `flavors:` patch from team.yaml (repeatable, applied in order) |
| `… --model [agent=]provider/model` | Override a model for one run (repeatable) |
| `… --safety strict\|balanced\|restricted\|autonomous` | Tool-approval mode; the teams here expect `strict` or `balanced` |
| `… --worktree[=name] [--worktree-base ref]` | Run in a fresh git worktree of the working directory; a remote-tracking base is fetched first |
| `… --worktree-pr <n>` | Run in a worktree on a pull request's branch (needs `gh`) |
| `… --working-dir <path>` | Working directory for tools and relative paths |
| `… --session -1 [--session-read-only]` | Resume or read the latest session |
| `docker agent debug config <team.yaml> [--flavor X]` | Print the resolved config; non-zero on a parse error |
| `docker agent debug toolsets <team>` / `debug skills <team>` | Which tools and skills each agent gets |
| `docker agent doctor <team>` | Credentials and harness logins |
| `docker agent alias add\|ls\|rm` | Name a team so it can be run from any directory |
| `docker agent toolsets` | List the built-in toolset types |

Default data directory: `~/.cagent` (sessions, worktrees under `~/.cagent/worktrees/`). Config directory: `~/.config/cagent`.

## team.yaml keys used here

Keys as `issue-team/team.yaml` uses them. Comments come from `--help`, `issue-team/README.md` and the receipts in [gotchas.md](gotchas.md); `docker agent debug config` is the check when in doubt.

```yaml
models:                       # named model configs, referenced by agents
  lead: { provider: anthropic, model: claude-sonnet-5 }

toolsets:                     # shared toolsets, attached with use_toolsets
  pr_threads:
    type: script
    shell:
      pr_threads:
        cmd: issue-team-pr-threads "$pr"     # resolved through PATH
        description: …
        args: { pr: { type: integer, description: … } }
        required: [pr]

agents:
  root:                       # the first agent is the default for `run`
    model: lead
    description: …            # what other agents see when delegating
    instruction_file: instructions/root.md   # relative to team.yaml
    add_prompt_files: [AGENTS.md, CLAUDE.md] # from the working directory
    add_environment_info: true
    sub_agents: [builder, tester, reviewer]  # reached with transfer_task
    use_toolsets: [pr_threads]
    skills: [test-quality-with-ai]
    toolsets:
      - type: shell
      - type: filesystem
        tools: [read_file, write_file]       # restrict to these tools
  builder:
    harness: { type: claude-code, effort: high }   # Claude Code as the agent; effort: low|medium|high|xhigh|max

permissions:
  deny: ["shell:cmd=*git push*--force*"]     # glob on the shell command; wins in every safety mode

flavors:                      # patches selected with --flavor; deep-merged
  low:
    models: { lead: { model: claude-haiku-4-5 } }
    agents: { builder: { harness: { effort: low } } }
```

## Built-in toolset types (v1.145.0)

From `docker agent toolsets`: `a2a`, `api`, `background_agents`, `background_jobs`, `environment`, `fetch`, `file`, `filesystem`, `git` (read-only), `lsp`, `mcp`, `mcp_catalog`, `memory`, `model_picker`, `open_url`, `openapi`, `plan`, `rag`, `scheduler`, `script`, `session_context`, `shell`, `tasks`, `think`, `todo`, `user_prompt`, `webhook`.

Only `shell`, `todo`, `filesystem`, `git` and `script` are used by a team here so far. When a team starts using another one, add what you learned to [patterns.md](patterns.md) or [gotchas.md](gotchas.md).
