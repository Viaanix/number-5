# Test-quality team

Runs the [`j5-test-quality`](../../skills/j5-test-quality/SKILL.md) skill against a project checkout: one entry point per skill workflow. The agents are native docker-agent agents on the local Pi proxy, built the way [`issue-team`](../issue-team/README.md) is. Each run reads that repository's `AGENTS.md` / `CLAUDE.md` and learns its test framework from its existing tests.

```bash
j5 test-quality audit --target launcher/test          # read-only; report to .j5/review/
j5 test-quality review-branch                         # read-only; report in the session
j5 test-quality write-tests --target "parseRequest in src/request.ts"
j5 test-quality fix-failing --test "bun test launcher/test/cli.test.ts"
j5 test-quality review-branch --print                 # show the docker agent command only
```

**Every entry point runs in your checkout itself**, on whatever branch is checked out, next to your uncommitted work: the tests to audit, review, extend or fix are the ones on your branch, which a fresh worktree from the default branch would not have. `write-tests` and `fix-failing` edit files there and leave the changes uncommitted for you to read.

## Prerequisite: the Pi proxy

Every model call goes to `http://127.0.0.1:4141/v1` (`containers/pi-openai-proxy`), which must be running, with `PI_PROXY_AUTH_TOKEN` exported or saved in `~/.config/cagent/.env`. Without the token docker-agent does not start the agent.

## Entry points

| Entry point | Agent | Skill workflow | May write | Output |
|---|---|---|---|---|
| `audit --target <path>` | `auditor`, regions handed to the `reader` sub-agent | `review-at-scale.md` (`review-single.md` for five files or fewer) | One new report file, through `write_report` | `.j5/review/test-quality-audit-<date>.md` in the project; `-2`, `-3`, … when that name exists, never an overwrite |
| `review-branch` | `reviewer` | `review-single.md` | Nothing | Verdict and findings for the tests the branch adds or changes, in the session |
| `write-tests --target <what>` | `writer` | `generate.md` | Test files; production code only to break and restore it while watching a new test fail | Tests added, the bug each catches, pre-screen and suite results |
| `fix-failing --test <test>` | `fixer` | `maintain-failing.md` | Production code; a test only with a written justification | Root cause, changes, before/after suite results |

`.j5/` is not ignored for you: add it to the project's `.gitignore` (or `.git/info/exclude`) if audit reports should stay out of `git status`.

## How it is built

| Piece | Where |
|---|---|
| The task | `message` in `workflow.yaml` (`{target}` / `{test}` are parameters): one sentence, nothing else |
| Each agent's procedure | `instructions/<agent>.md`: shell and timeout rules, untrusted-text rule, how the skill maps onto the agent's tools, the output template |
| The skill | Byte-identical copies in `instructions/skill/`, listed in each agent's `instruction_file` after its own file: the router (`j5-test-quality.md`), the one workflow the agent follows, and `mock-antipatterns`, `fig-leaf-signals`, `pre-claim`, `assertion-shape`. `instruction_file` only accepts paths inside the team directory, hence copies; `test/skill-instructions.test.ts` fails when one drifts or an extra file is left behind. Only the framework references (`vitest-patterns.md`, `bun-test-patterns.md`) are read from `~/.agents/skills/j5-test-quality` (installed by `scripts/install.ts`), because which one applies depends on the project; the agent names the one it read |
| Deterministic steps | Helpers in `helpers/`, launched from `bin/` (`j5` puts `bin/` on `PATH`), exposed as typed script tools |
| Models and effort | `team.yaml`: one named model per agent, each with an explicit `reasoning_effort` (the proxy requires it) |

### Tools per agent

| Agent | Files | git | Script tools | Shell |
|---|---|---|---|---|
| `auditor` | read only (`read_file`, `read_multiple_files`, `list_directory`, `directory_tree`, `search_files_content`) | read-only toolset | `test_prescreen` (optional `target`), `write_report` (`content`), `transfer_task` to `reader` | no |
| `reviewer` | read only | read-only toolset | `test_prescreen`, `change_diff` | no |
| `reader` (the auditor's sub-agent) | read only | read-only toolset | none | no |
| `writer` | read, write, edit, create/remove directory | through `shell` | `test_prescreen` (optional `target`) | yes |
| `fixer` | same as `writer` | through `shell` | `test_prescreen` (optional `target`) | yes |

Verified with `docker agent debug toolsets team.yaml`: that list is what each agent gets.

### Models

| Agent | Model | Effort | `low` flavor |
|---|---|---|---|
| `auditor`, `reviewer` | `claude-opus-4-7` | high | `claude-sonnet-5-5`, high |
| `writer`, `fixer`, `reader` | `claude-sonnet-5-5` | high | `claude-haiku-5-5`, medium |

These roles used Opus 5.5 under the old Claude Code harness. `claude-opus-5-5` is not usable through the proxy: Anthropic answers "Claude Code 2.1.75 does not support this model; version 2.1.280/2.1.251 or newer is required" to Pi's login (observed 2026-10-15, docker-agent v1.145.0), so the two judgment roles run on `claude-opus-4-7`, the newest Opus the proxy serves. The `low` efforts are the ones `issue-team`'s `low` flavor uses for the same tiers.

### Helpers

| Script | Tool | Output |
|---|---|---|
| `test-quality-prescreen [target]` (or `target` in the environment) | `test_prescreen` | The skill's Tier 1 pre-screen in strict mode. With a target, every test file under it; without, the test files the branch changed, including uncommitted ones and new files after `git add -N`. Exit 1 = HIGH findings, 2 = could not run |
| `test-quality-change-diff` | `change_diff` | The branch's commits and full diff since the default branch, then uncommitted work |
| `test-quality-write-report` (`content` in the environment) | `write_report` | Writes `.j5/review/test-quality-audit-<local date>.md` under the working directory, creating the directory, never overwriting (`-2`, `-3`, …); prints the path. Refuses empty content and content over 30,000 characters (the text travels in an environment variable) |

The first two wrap `launcher/src/test-prescreen.ts` and `launcher/src/change-diff.ts`, which the issue team's helpers use too. Tool arguments reach a helper as environment variables, and none is named `path`: that would replace `PATH` on Windows.

## Guard rails

**Enforced by tool selection.** `auditor`, `reviewer` and `reader` are given no shell and no write or edit tool, so they cannot change a file or git state. The auditor's `write_report` can only create a new file under `.j5/review/` with a date-derived name, whatever the report text says.

**Defense in depth, not a boundary.** `permissions` in `team.yaml` are team-wide: they pre-approve every tool the team uses (so `--exec` runs never wait on a prompt) and deny shell commands containing `sudo`, the hook-bypass flag, `git commit|push|stash|reset|checkout|restore|switch|clean`, and a few `gh` commands. `git add -N` stays allowed. `shell` can still run anything the patterns miss, so for `writer` and `fixer` these back up the instructions.

**Instructions only.**

- `writer` and `fixer` are told not to commit, push, stash, reset, check out, restore or switch anything.
- Agents are told never to weaken, skip or delete a failing test to make it pass; `fixer` changes a test only with a written justification.
- `writer` breaks production code on purpose to watch each new test fail, then edits it back by hand (the git restore commands are denied, and would discard your uncommitted work in that file). A run that dies in between leaves that line broken; `git diff` shows it.

## Verified

2026-10-15, docker-agent v1.145.0, on the machine that built this:

- `docker agent debug config team.yaml` and `… --flavor low` parse; no agent has a `harness:` key; each agent's model resolves to the one in the table above in both.
- `docker agent debug toolsets team.yaml` lists the tools in the table above.
- `PI_PROXY_AUTH_TOKEN=placeholder docker agent run team.yaml --agent <auditor|reviewer|writer|fixer> --dry-run --exec x`, with `bin/` on `PATH`, initialises each agent.
- `j5 test-quality audit --target … --print` builds the command with the one-sentence task.
- `bun test workflows/test-quality`: the helper tests (including the report helper: new name each run, `-2`/`-3` suffix instead of overwrite, directory created, empty and oversized content refused, nothing written outside `.j5/review`) and the skill-copy drift test pass.

## Not verified

- No live model run of any entry point: no agent has talked to the proxy since the conversion from the Claude Code harness. Whether the models follow the instructions (transfer_task to `reader` with the verbatim template, the verdict template, mutation-then-restore) is untested.
- That Opus 4.7 and Sonnet 5.5 accept every request these agents send through the proxy (the `reasoning_effort` values are copied from `issue-team`; the `low` flavor's Haiku 5.5 was not tried).
- That the permission `deny` patterns match as intended inside a live run (only parsed).
- That a 30,000-character report passes through the environment on Windows.
- The earlier harness-era check of `review-branch` (2026-10-14) does not carry over.

## Check it

```bash
bun run validate:teams                       # manifest, agents, config, flavor, dry runs
j5 test-quality review-branch --print        # the full command
```
