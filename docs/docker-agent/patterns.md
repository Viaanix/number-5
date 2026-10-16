# docker-agent team patterns

Patterns that the teams in this repository use on purpose. Each one names the problem it solves and where to see it. `workflows/issue-team/` is the reference implementation; read its `team.yaml`, `workflow.yaml` and `instructions/` alongside this page.

**Two kinds of agent.** Every team here (issue-team, pr-reviewer, test-quality, triage) runs native docker-agent agents on the local Pi proxy, with their own tools, instruction files, sub-agents and permission rules. docker-agent can also run Claude Code harness agents (`harness: claude-code`, on a Claude subscription, no API key); no team uses one now, and the harness notes below remain for anyone who does. A harness agent gets nothing but its task message: instruction files, toolsets, skills, `sub_agents`, `add_prompt_files` and `permissions` are dropped ([gotcha](gotchas.md#a-harness-claude-code-agent-gets-none-of-docker-agents-agent-extras)). Patterns marked *(native agents)* need docker-agent's own model agents.

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

### A reviewer on a different model class than the builders
A model reviewing work from its own class shares its blind spots. The manifest's `independence` block names the reviewer and the agents it reviews; team.yaml offers `reviewer-on-<tier>` flavors that each patch only the reviewer's model; `j5` reads the real models after the effort is applied and picks the tier one step above the builders (one below from the top), then verifies the result and refuses to launch otherwise. A flavor is used instead of `--model` so the reviewer keeps its `reasoning_effort`. See `docs/launcher.md`.

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

### Load required context into the prompt, don't ask the agent to fetch it
Anything the agent must have *before* it acts belongs in `instruction_file` (a list is joined in order), not in a step that says "read X first". Seen in issue-team's first real run: the reviewer's checklist told it to read the j5-test-quality review workflow and it never did (it read four source files and called `change_diff`), while the tester read its skill and the PR template, commits and prescreen steps were all followed. Agents reliably do what is on the path to their output and skip reads and bookkeeping that precede it. `instruction_file` only accepts paths inside the team directory ([gotcha](gotchas.md#skills)), so the skill files are copies, with a test that fails when they drift. After the workflow was injected, the second run's reviewer applied it but skipped the four checklists it names, and said so in its report; those are injected too. What cannot be injected, such as a framework reference that depends on the project, is still a read the model may skip: say in the output template what it must report having read, so skipping shows.

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

### Model and effort are standard, generated flavors
Every team offers the same two options, `--model <tier>` and `--effort <level>`, as flavors named `model-<tier>` and `effort-<level>`. docker-agent cannot share flavor definitions between files (they live in each `team.yaml`; its own idea of reuse is the same names everywhere), so `workflows/flavors.yaml` defines them once and `bun run flavors` writes each team's block from it and from the team's list of tunable models. Model and effort flavors patch different keys, so they combine in either order, and no flavor means the file as written. `validate:teams` proves each flavor does what its name says from docker-agent's merged config, because a flavor that repeats the base values changes nothing and applies without a word. Where a team keeps a reviewer off the builders' model class, the reviewer's own flavors are `j5`'s, not the user's.
