# Claude Code in a pinned container (spike)

**Status:** spike for [issue #3](https://github.com/vx-daniel/number-5/issues/3). Nothing in `j5` uses this yet.

## Why

The only model access is a Claude subscription. Anthropic allows a subscription only through its own client, Claude Code. So docker-agent can run Claude only as its `claude-code` harness, and a harness agent gets none of docker-agent's own features: toolsets, `permissions.deny`, instruction files, sub-agents and skills are all dropped. On top of that, the harness inherits the user's local Claude Code: its version, global `CLAUDE.md`, plugins, MCP servers and hooks. Results differ from machine to machine.

This folder tests the alternative: Claude Code itself as the agent runtime, pinned in a container, and configured only by this repository.

## What's here

| File | What |
|---|---|
| `Dockerfile` | Claude Code at a pinned version (`CLAUDE_CODE_VERSION`), `git`, and Claude Code's whole config folder (`CLAUDE_CONFIG_DIR`) taken from `claude-config/` |
| `claude-config/settings.json` | Team settings: permission `deny` rules |
| `team/agents.json` | Team-defined agents. The spike has one: `reviewer`, with `tools: Read, Grep, Glob`, `model: haiku`, and a neutral prompt |
| `run-spike.sh` | Builds the image, clones a repository into `~/.cache/j5-claude-code-spike/`, runs the reviewer there with an order to create a file, and checks the transcript |

## Run it

```bash
claude setup-token            # once, in your own terminal; needs a Claude subscription
# store the token in ~/.config/j5/claude-oauth-token and chmod 600 it
containers/claude-code/run-spike.sh <repository>   # a local path or a git URL, e.g. git@github.com:Owner/repo.git
```

`<repository>` is anything `git clone` accepts: a local checkout or an SSH or HTTPS URL, but not the `Owner/repo` shorthand. It is cloned into `~/.cache/j5-claude-code-spike/work`; the original is never touched.

The token reaches the container as `CLAUDE_CODE_OAUTH_TOKEN` in its environment, never as an argument. Docker Desktop on Linux only mounts folders shared with it: the home folder is, `/tmp` is not. That's why the clone goes under `~/.cache`.

## Results (2026-10-15, Claude Code 2.1.284, Docker 29.8.2)

| Check | Result |
|---|---|
| Subscription setup-token login in the container | Works |
| Model | Only `claude-haiku-4-5-20251001`, from the agent definition, not the user's own default (`opus[1m]`) |
| Tools offered (from the transcript) | Exactly `Glob`, `Grep`, `Read`. With `Write` added to the definition, the check fails: it detects a change to the tool list |
| A write the agent tried anyway | With `Write` offered, Claude Code refused it: "Claude requested permissions to write to … but you haven't granted it yet". In `-p` mode, without `--dangerously-skip-permissions`, anything the settings don't allow is denied, not asked |
| The user's own setup | Not present: no global `CLAUDE.md`, plugins, MCP servers, hooks or advisor |

So there are **two layers of enforcement**, both defined in the repo:
- an agent's `tools` decide what it can try;
- `permissions` in `settings.json` decide what actually runs.

A builder agent will need explicit `allow` rules for writing files and for its test commands; everything else stays denied.

**Correction to the first spike:** with a "read-only" prompt, the agent refused to write even when `Write` was offered. "No file was written" alone proves nothing about enforcement. That's why the prompt is now neutral and the check reads the tool list.

## Not tested yet

- An agent with Bash, plus `allow` and `deny` rules
- `git push` from inside the container (SSH agent forwarding, or `GH_TOKEN` over HTTPS)
- `gh` and `bun` in the image, for the team helpers
- A worktree: its `.git` file points into the main checkout, which must be mounted at the same path
- Sub-agents (`Agent`) with their own tool lists and models
- The advisor (not present in the container; may not be configurable)
