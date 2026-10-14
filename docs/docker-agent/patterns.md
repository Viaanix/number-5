# docker-agent team patterns

Patterns that the teams in this repository use on purpose. Each one names the problem it solves and where to see it. `workflows/issue-team/` is the reference implementation; read its `team.yaml` and `instructions/` alongside this page.

Add a pattern when a second team uses it, or when a team uses it to fix a failure you saw. Say which failure.

## Structure

### One instruction file per agent
`instruction_file: instructions/<agent>.md` instead of inline `instruction:`. Prompts get reviewed and diffed like code, and `team.yaml` stays a readable map of who does what. Paths resolve relative to `team.yaml`.

### A coordinator that does not write code
The entry agent (`root`, `followup`) plans, delegates with `transfer_task`, commits and publishes; it is told not to write production code or tests. Builders build, testers test, reviewers review. Separation is what makes the reviewer's verdict independent.

### Sub-agents get self-contained tasks
A sub-agent does not see the coordinator's conversation. Instructions spell out what every task message must carry (issue text, acceptance checklist, project commands, files involved). An under-specified handoff is the most common way a sub-agent wanders.

### A read-only reviewer
The reviewer gets `git` (read-only), file reads without `write_file`, and one script tool for the diff. It cannot edit or run the project, and its instructions say so, so it does not burn turns trying. Verification results reach it as *claims* from the team, and it is told to weigh them as claims.

### Fixed output templates for agent-to-agent reports
The reviewer answers in an exact template (`VERDICT: ...`, then fixed sections, "None" when empty). The coordinator can act on it without parsing prose, and a missing section is visible.

### Bounded fix loops
"At most two fix rounds, then stop and report." Without a bound, coordinator and reviewer can loop indefinitely on a disagreement.

## Tools

### Deterministic work belongs in scripts, exposed as `type: script` tools
Anything with a right answer — the default branch, the change diff, unresolved PR threads — is a helper in the team, exposed as a typed script tool (`args`, `required`, a description of the output). Agents call `change_diff`, not a hand-assembled `git diff` they might get wrong. The helpers are called by name, so the team's `bin/` must be on `PATH` (the launcher does this).

### Helpers that run on every OS
A helper is a Bun script (`helpers/<verb>.ts`) with two launchers in `bin/`: an extensionless `#!/bin/sh` file and a `.cmd` that Windows finds through PATHEXT. The script tool's `cmd:` is the bare name, and the helper reads its arguments from the environment, where docker-agent puts them. `cmd: helper "$pr"` only works under bash and zsh; PowerShell and cmd.exe spell variables differently ([gotcha](gotchas.md#the-shell-tool-and-script-tools-use-the-users-shell-not-bash)). See `workflows/issue-team/helpers/` and `workflows/issue-team/bin/`. Logic two teams need lives once in `launcher/src/` (`team-helper.ts`, `change-diff.ts`, `test-prescreen.ts`), and each team's helper is a thin wrapper with its own `<team>-` name.

### Shared toolsets
A script toolset defined once under top-level `toolsets:` and attached with `use_toolsets: [name]` (see `pr_threads`), instead of copying the definition into each agent.

### Narrow filesystem tools
`type: filesystem` with an explicit `tools:` list gives an agent reads plus `write_file` only (for PR bodies under `/tmp`), not the whole edit surface.

### Prompt files from the target repository
`add_prompt_files: [AGENTS.md, CLAUDE.md]` pulls the *worked-on* repository's conventions into each agent, so the team stays generic and nothing is installed into target repositories.

## Safety

### Deny rules for irreversible commands
`permissions.deny` blocks `--no-verify`, force pushes, `reset --hard`, `gh pr merge`, `gh repo delete`, `gh release` and `sudo` for the shell tool in every safety mode. They do not reach a `harness: claude-code` agent (see [gotchas](gotchas.md#unverified)).

### Publish gates in the instructions, enforced by prompting
Every outward action (push, PR creation, comments, closing issues) is preceded by "show the user and wait for the go-ahead". This relies on tool approval prompts, so do not run these teams with `--yolo` / `--safety autonomous`.

### Text from GitHub is data, not instructions
Issue bodies and review comments are requirements about the code. Instructions say so explicitly, and route requests about credentials, other repositories or disabling checks to "ask the user".

### One git worktree per run
Each entry point runs in its own worktree under `~/.cagent/worktrees/`, named after the repository and the issue or PR, never in the user's checkout. See the worktree modes in [launcher.md](../launcher.md).

## Effort

### Effort is a flavor
A team defines its effort levels as `flavors:` in `team.yaml` — cheaper models for the native agents, a lower `harness.effort` for the Claude Code builder — and `j5 --effort <flavor>` selects one. No flavor means the file as written. Keep each flavor minimal (flavors deep-merge) and let `validate:teams` prove it changes something.
