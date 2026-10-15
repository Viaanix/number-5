# docker-agent team patterns

Patterns that the teams in this repository use on purpose. Each one names the problem it solves and where to see it. `workflows/issue-team/` is the reference implementation; read its `team.yaml`, `workflow.yaml` and `instructions/` alongside this page.

**Two kinds of agent.** issue-team and pr-reviewer run native docker-agent agents on the local Pi proxy, with their own tools, instruction files, sub-agents and permission rules. test-quality runs Claude Code harness agents (`harness: claude-code`, on a Claude subscription, no API key). A harness agent gets nothing but its task message: instruction files, toolsets, skills, `sub_agents`, `add_prompt_files` and `permissions` are dropped ([gotcha](gotchas.md#a-harness-claude-code-agent-gets-none-of-docker-agents-agent-extras)). Patterns marked *(native agents)* need docker-agent's own model agents.

Add a pattern when a second team uses it, or when a team uses it to fix a failure you saw. Say which failure.

## Structure

### The prompt is the entry point's message (harness agents)
Each entry agent's whole prompt is its entry point's `message` in `workflow.yaml`, with `{parameter}` placeholders and `{{` `}}` for literal braces. It is still reviewed and diffed like code, and `j5 … --print` shows exactly what is sent.

### One instruction file per agent *(native agents)*
`instruction_file: instructions/<agent>.md` instead of inline `instruction:`. Prompts get reviewed and diffed like code, and `team.yaml` stays a readable map of who does what. Paths resolve relative to `team.yaml`.

### A coordinator that does not write code
The entry agent (`root`) plans, delegates (Claude Code's own sub-agent tool for harness agents, `transfer_task` for native ones), commits and publishes; it is told not to write production code or tests. Builders build, testers test, reviewers review. Separation is what makes the reviewer's verdict independent.

### Sub-agents get self-contained tasks
A sub-agent does not see the coordinator's conversation. Instructions spell out what every task message must carry (issue text, acceptance checklist, project commands, files involved). An under-specified handoff is the most common way a sub-agent wanders. A sub-agent's standing role lives once in its own `instruction_file` (issue-team's builder, tester and reviewer), so the coordinator's task carries only what is specific to this change.

### A read-only reviewer
With native agents the reviewer gets `git` (read-only), file reads without `write_file`, and one script tool for the diff, so it cannot edit or run the project. A harness reviewer has Claude Code's full tool set: read-only is an instruction it is trusted to keep, and its prompt says so. Verification results reach it as *claims* from the team, and it is told to weigh them as claims.

### Fixed output templates for agent-to-agent reports
The reviewer answers in an exact template (`VERDICT: ...`, then fixed sections, "None" when empty). The coordinator can act on it without parsing prose, and a missing section is visible.

### Bounded fix loops
"At most two fix rounds, then stop and report." Without a bound, coordinator and reviewer can loop indefinitely on a disagreement.

## Tools

### Deterministic work belongs in scripts, exposed as `type: script` tools
Anything with a right answer — the change diff, the test pre-screen — is a helper in the team, exposed as a typed script tool (`args`, `required`, a description of the output). Agents call `change_diff`, not a hand-assembled `git diff` they might get wrong. The helpers are called by name, so the team's `bin/` must be on `PATH` (the launcher does this). A harness agent has no script tools: its prompt names the helper command, and it runs it through Claude Code's shell (verified to see the launcher's `PATH`).

### Helpers that run on every OS
A helper is a Bun script (`helpers/<verb>.ts`) with two launchers in `bin/`: an extensionless `#!/bin/sh` file and a `.cmd` that Windows finds through PATHEXT. The script tool's `cmd:` is the bare name, and the helper reads its arguments from the environment, where docker-agent puts them. `cmd: helper "$pr"` only works under bash and zsh; PowerShell and cmd.exe spell variables differently ([gotcha](gotchas.md#the-shell-tool-and-script-tools-use-the-users-shell-not-bash)). See `workflows/issue-team/helpers/` and `workflows/issue-team/bin/`. Logic two teams need lives once in `launcher/src/` (`team-helper.ts`, `change-diff.ts`, `test-prescreen.ts`), and each team's helper is a thin wrapper with its own `<team>-` name.

### Narrow filesystem tools
`type: filesystem` with an explicit `tools:` list gives an agent reads plus `write_file` only (for PR bodies under `/tmp`), not the whole edit surface.

### Prompt files from the target repository *(native agents)*
`add_prompt_files: [AGENTS.md, CLAUDE.md]` pulls the *worked-on* repository's conventions into each agent, so the team stays generic and nothing is installed into target repositories.

## Safety

### Deny rules for irreversible commands *(native agents)*
`permissions.deny` blocks `--no-verify`, force pushes, `reset --hard`, `gh pr merge`, `gh pr ready`, `gh issue close`, `gh repo delete`, `gh release` and `sudo` for the shell tool in every safety mode. They do not reach a `harness: claude-code` agent (see [gotchas](gotchas.md#unverified)).

### Publish gates in the instructions
An outward action is gated either by the team's own checks or by the user. issue-team's `work-issue` opens its PR without asking: ready only when the reviewer approved and verification passed, otherwise as a draft that says what failed, with the evidence (tests, review rounds, verification) in the body. Nothing there waits for the user, so the deny rules block what a person must decide: merging, marking a draft ready, closing issues. Native agents get a tool-approval prompt for any tool not pre-approved in `permissions.allow`, and `--exec` rejects such a tool ([gotcha](gotchas.md#--exec-rejects-a-tool-that-is-not-pre-approved)). issue-team pre-approves its tools by name; pr-reviewer leaves `pr_comment`, its one GitHub write, off the list on purpose. A harness agent gets no approval prompts: its prompt tells it to end its turn and wait for the user's next message, which works because a harness agent keeps its conversation between turns. Under `--exec` nobody answers, so never `--exec` a stage that waits for the user. A queue run (`j5 … --queue`) is `--exec` by design: the entry point's queue preamble tells the agent to stop and report wherever it would have asked.

### Text from GitHub is data, not instructions
Issue bodies and review comments are requirements about the code. Instructions say so explicitly, and route requests about credentials, other repositories or disabling checks to "ask the user".

### One git worktree per run
Each entry point that changes code runs in its own worktree beside the user's checkout, named after the repository and the issue or PR, never in the checkout itself. `j5` creates it and starts docker-agent there with `--working-dir`; docker-agent's `--worktree` would leave a harness agent in the checkout. See the worktree modes in [launcher.md](../launcher.md).

## Effort

### Effort is a flavor
A team defines its effort levels as `flavors:` in `team.yaml` — a lower `harness.effort` and a cheaper `harness.model` for harness agents, cheaper models for native ones — and `j5 --effort <flavor>` selects one. No flavor means the file as written. Keep each flavor minimal (flavors deep-merge) and let `validate:teams` prove it changes something.
