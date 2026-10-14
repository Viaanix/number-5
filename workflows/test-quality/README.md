# Test-quality team

Runs the [`j5-test-quality`](../../skills/j5-test-quality/SKILL.md) skill against a project checkout: one entry point per skill workflow. Every agent is Claude Code running on your Claude subscription (`harness: claude-code`); no API key is needed. Each run reads that repository's `CLAUDE.md` and learns its test framework from its existing tests.

```bash
j5 test-quality audit --target launcher/test          # read-only; report to .j5/review/
j5 test-quality review-branch                         # read-only; report in the session
j5 test-quality write-tests --target "parseRequest in src/request.ts"
j5 test-quality fix-failing --test "bun test launcher/test/cli.test.ts"
j5 test-quality review-branch --print                 # show the docker agent command only
```

**Every entry point runs in your checkout itself**, on whatever branch is checked out, next to your uncommitted work: the tests to audit, review, extend or fix are the ones on your branch, which a fresh worktree from the default branch would not have. `write-tests` and `fix-failing` edit files there and leave the changes uncommitted for you to read.

## Entry points

| Entry point | Agent | Skill workflow | May write | Output |
|---|---|---|---|---|
| `audit --target <path>` | `auditor`, regions handed to Claude Code sub-agents | `review-at-scale.md` (`review-single.md` for five files or fewer) | One report file | `.j5/review/test-quality-audit-<date>.md` in the project; never overwrites an earlier one |
| `review-branch` | `reviewer` | `review-single.md` | Nothing | Verdict and findings for the tests the branch adds or changes, in the session |
| `write-tests --target <what>` | `writer` | `generate.md` | Test files; production code only to break and restore it while watching a new test fail | Tests added, the bug each catches, pre-screen and suite results |
| `fix-failing --test <test>` | `fixer` | `maintain-failing.md` | Production code; a test only with a written justification | Root cause, changes, before/after suite results |

`.j5/` is not ignored for you: add it to the project's `.gitignore` (or `.git/info/exclude`) if audit reports should stay out of `git status`.

## How it is built

docker-agent gives a harness agent nothing but its task message: instruction files, toolsets, skills, `sub_agents` and `permissions` are dropped without an error ([gotcha](../../docs/docker-agent/gotchas.md#a-harness-claude-code-agent-gets-none-of-docker-agents-agent-extras)). So:

| Piece | Where |
|---|---|
| Each agent's whole prompt | its entry point's `message` in `workflow.yaml` (`{target}` / `{test}` are parameters; `{{` `}}` are literal braces) |
| Agents, models and effort levels | `team.yaml`: four `harness: claude-code` agents at effort `high`, `auditor` and `reviewer` on Opus 5.5, `writer` and `fixer` on Sonnet 5.5 (`harness.model`); the `low` flavor steps each down a tier (Sonnet / Haiku 4.5) at effort `low` |
| The skill | read by path from `~/.agents/skills/j5-test-quality/` (installed by `bun scripts/install.ts`); it is not one of Claude Code's skills, and the prompts say not to use the older `test-quality-with-ai` |
| Deterministic steps | helpers in `bin/` that the prompts run by bare name through Claude Code's shell; `j5` puts `bin/` on `PATH` |

## Helper scripts (`helpers/`, launched from `bin/`)

| Script | Used by | Output |
|---|---|---|
| `test-quality-prescreen [target]` (or `target` in the environment) | every agent | The skill's Tier 1 pre-screen in strict mode. With a target, every test file under it; without, the test files the branch changed, including uncommitted ones and new files after `git add -N`. Exit 1 = HIGH findings, 2 = could not run |
| `test-quality-change-diff` | reviewer | The branch's commits and full diff since the default branch, then uncommitted work |

Both are thin wrappers over `launcher/src/test-prescreen.ts` and `launcher/src/change-diff.ts`, which the issue team's helpers use too. The pre-screen runs this repository's copy of the skill's script, not the installed one. The argument is `target`, not `path`: a tool argument named `path` would replace `PATH` on Windows.

## Guard rails

**Instructions only.** Claude Code runs its own tools, outside docker-agent's safety modes and `permissions` rules, so nothing here is enforced:

- `audit` and `review-branch` are told to be read-only, apart from the audit's one report file.
- Every prompt forbids commits, pushes, stashes, resets, checkouts, restores and branch switches; `git add -N` is allowed.
- Agents are told never to weaken, skip or delete a failing test to make it pass; `fix-failing` changes a test only with a written justification.

`write-tests` breaks production code on purpose to watch each new test fail, then edits it back. A run that dies in between leaves that file broken; `git diff` shows it.

## Verified

`review-branch`, 2026-10-14, docker-agent v1.145.0, Claude Code 2.1.284, through `j5 … -- --exec` on a throwaway repository whose feature branch adds `clamp()` and one test with `test.only` and `toBeDefined()`: `VERDICT: Needs work`, with the `.only` at `math.test.ts:4`, the value-blind assertion, and both untested clamping branches. It ran `test-quality-change-diff` and `test-quality-prescreen` by bare name, read the skill from `~/.agents/skills/j5-test-quality/`, and left `git status` clean. `audit`, `write-tests` and `fix-failing` have only been dry-run.

## Check it

```bash
bun run validate:teams                       # manifest, agents, config, flavor, dry runs
j5 test-quality review-branch --print        # the full command, prompt included
```
