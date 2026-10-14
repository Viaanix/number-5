# Test-quality team

Runs the [`j5-test-quality`](../../skills/j5-test-quality/SKILL.md) skill against a project checkout: one entry point per skill workflow. Each run reads that repository's `AGENTS.md` / `CLAUDE.md` and learns its test framework from its existing tests.

```bash
j5 test-quality audit --target launcher/test          # read-only; report to .j5/review/
j5 test-quality review-branch                         # read-only; report in the session
j5 test-quality write-tests --target "parseRequest in src/request.ts"
j5 test-quality fix-failing --test "bun test launcher/test/cli.test.ts"
j5 test-quality review-branch --print                 # show the docker agent command only
```

**Every entry point runs in your checkout itself**, on whatever branch is checked out, next to your uncommitted work: the tests to audit, review, extend or fix are the ones on your branch, which a fresh worktree from the default branch would not have. `write-tests` and `fix-failing` edit files there and leave the changes uncommitted for you to read.

## Entry points

| Entry point | Agent | Skill workflow | Writes | Output |
|---|---|---|---|---|
| `audit --target <path>` | `auditor` (review model), regions handed to `reader` (lead model) | `review-at-scale.md` (`review-single.md` for five files or fewer) | One report file only | `.j5/review/test-quality-audit-<date>.md` in the project (no date if the agent cannot tell it); never overwrites an earlier one |
| `review-branch` | `reviewer` (review model) | `review-single.md` | Nothing | Verdict and findings for the tests the branch adds or changes, in the session |
| `write-tests --target <what>` | `writer` (lead model) | `generate.md` | Test files; production code only to break and restore it while watching a new test fail | Tests added, the bug each catches, pre-screen and suite results |
| `fix-failing --test <test>` | `fixer` (lead model) | `maintain-failing.md` | Production code; a test only with a written justification | Root cause, changes, before/after suite results |

`.j5/` is not ignored for you: add it to the project's `.gitignore` (or `.git/info/exclude`) if audit reports should stay out of `git status`.

## Stack

| Layer | What | Where |
|---|---|---|
| Runtime | docker-agent v1.145.0 (`docker agent`) | Docker CLI plugin |
| Team config | Agents, models, the shared `test_prescreen` toolset, deny rules | `team.yaml` |
| Prompts | One instruction file per agent | `instructions/*.md` |
| Helpers | Bun scripts exposed as tools, launched from `PATH` by an `sh` launcher (Linux, macOS) or a `.cmd` (Windows) | `helpers/*.ts`, `bin/` |
| Entry points | `audit`, `review-branch`, `write-tests`, `fix-failing` | `workflow.yaml` (for `j5`) |
| Effort levels | `low` flavor: haiku lead, sonnet review | `team.yaml` → `flavors` |
| Models | `lead` = `anthropic/claude-sonnet-5-5`, `review` = `anthropic/claude-opus-5-5` | `team.yaml` → `models` |
| Skill | `j5-test-quality`; the agents read its workflow files from `~/.agents/skills/j5-test-quality/` | `skills/j5-test-quality` in this repository, installed by `bun scripts/install.ts` |

## Helper scripts (`helpers/`, launched from `bin/`)

| Script | Used by | Output |
|---|---|---|
| `test-quality-prescreen [target]` (or `target` in the environment) | every agent but `reader` (`test_prescreen` tool) | The skill's Tier 1 pre-screen in strict mode. With a target, every test file under it; without, the test files the branch changed, including uncommitted ones and new files after `git add -N`. Exit 1 = HIGH findings, 2 = could not run |
| `test-quality-change-diff` | reviewer (`change_diff` tool) | The branch's commits and full diff since the default branch, then uncommitted work |

Both are thin wrappers over `launcher/src/test-prescreen.ts` and `launcher/src/change-diff.ts`, which the issue team's helpers use too. The pre-screen runs this repository's copy of the skill's script, not the installed one. The argument is `target`, not `path`: docker-agent passes tool arguments as environment variables, and Windows environment variable names are case-insensitive.

## Guard rails

- `audit` and `review-branch` agents have no shell and no edit tools. The auditor's `write_file` and `create_directory` are for its report; that limit is in its instructions, not enforced by docker-agent.
- `team.yaml` denies, for docker-agent's shell tool in every safety mode: commits, pushes, `--no-verify`, and every git command that moves `HEAD`, rewrites the index or discards work (`reset`, `checkout`, `switch`, `restore`, `stash`, `clean`, `rebase`, `merge`), plus `gh pr merge`, `gh repo delete`, `gh release` and `sudo`. `git add -N`, which the pre-screen needs for new test files, stays allowed.
- Agents never weaken, skip or delete a failing test to make it pass. `fix-failing` changes a test only with a written justification of the behavior change.

## Check it

```bash
bun run validate:teams                                   # manifest, agents, config, flavor, dry runs
docker agent debug toolsets workflows/test-quality/team.yaml   # tools each agent gets (bin/ on PATH)
docker agent debug skills workflows/test-quality/team.yaml     # every agent sees j5-test-quality
```

A skill that is not installed is dropped without an error ([gotcha](../../docs/docker-agent/gotchas.md#a-skill-that-is-not-installed-is-silently-dropped)); run `bun scripts/install.ts` after the skill changes.
