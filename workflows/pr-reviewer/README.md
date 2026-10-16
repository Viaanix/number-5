# PR reviewer

A native Docker Agent reviewer using the [Pi proxy container](../../containers/pi-openai-proxy/README.md).
It reviews an existing pull request in a separate worktree, returns the report
locally, and posts a finished verdict report as one comment on the PR. It never
approves or requests changes, edits code, or runs the project's tests/builds.
Existing workflows are unchanged.

## Run

Needs Bun, Docker Agent 1.145.0, git, `gh` authenticated for the target repository,
and the proxy's local bearer secret available as `PI_PROXY_AUTH_TOKEN`: export
it, or save it once in `~/.config/cagent/.env` with mode `0600` as described in
the [proxy setup](../../containers/pi-openai-proxy/README.md#build-and-log-in).
Docker Agent loads that file automatically in new terminals. This secret is not
an Anthropic API key. Claude's subscription login is separately persisted in the
container's `pi-auth` volume; neither login nor exporting the token is required
for every review when both are saved.

Complete subscription login and start the container using its README. After
updating this checkout, run `docker compose up --wait` from
`containers/pi-openai-proxy/` to apply the current-model catalogue mount; the
existing login volume is retained. If the token is saved but not exported, use
`docker compose --env-file "$HOME/.config/cagent/.env" up --wait` instead.

With multiple GitHub accounts, check `gh api user --jq .login` and select the
account that can read the target repository using
`gh auth switch --hostname github.com --user ACCOUNT`. This uses an existing
saved login; git's SSH host alias does not select the GitHub CLI account.

From the project checkout:

```bash
j5 pr-reviewer review --pr 123
j5 pr-reviewer review --pr 123 --model haiku --effort medium
j5 pr-reviewer review --pr 123 --project ~/code/app --print
```

Without the installed alias, use this repository's `bin/j5`. The reviewer's 12
read-only tools are pre-approved by name in `team.yaml`
(`permissions.allow`), so a review runs without per-call prompts. A tool added
later still asks. For a non-interactive run, add `--exec`:

```bash
j5 pr-reviewer review --pr 123 -- --exec
```

`--safety autonomous` is not needed and would also approve any tool you add later.

### Reviewing every pull request that has changed

```bash
j5 pr-reviewer review --queue-unreviewed          # every open, non-draft PR without a review of its latest commit
j5 pr-reviewer review --queue 120,123             # exactly these
j5 pr-reviewer review --queue-label needs-review  # every open PR with a label
```

Each queued PR is reviewed unattended, in its own detached worktree, and posts its report as a
comment. `--queue-unreviewed` is meant for a schedule: it asks `gh` which PRs are open and
which carry this account's own `Reviewed head SHA:` stamp for their current head, so a PR
comes back after a push and a run that has caught up prints `no open pull request needs a
review` and exits 0. Drafts are skipped; reviews and stamps from other accounts are ignored.
Each item ends with `RESULT: DONE <verdict> PR #<n>: <reason>` or `RESULT: FAILED <reason>`
(a BLOCKED review, or a comment that was not posted, is FAILED), and the queue's summary under
`.j5/queue/` lists them. The launcher's [queue documentation](../../docs/launcher.md#pull-request-queues)
has the rest, including why a single `--pr` run still asks before posting and a queued run does
not: j5 adds a generated `queue-unattended` flavor that approves `pr_comment` for queue runs only.

The team defines its own provider, so `~/.config/cagent/config.yaml` is optional.
The endpoint is `http://127.0.0.1:4141/v1`; change the team's provider URL if you
change the proxy's published port. The proxy must already be running; the workflow
does not start Docker services or obtain credentials for you.

## Models and instructions

| Selection | Model | Adaptive reasoning effort |
|---|---|---|
| Default | `claude-sonnet-5-5` | `high` |
| `--model haiku\|sonnet\|opus\|fable` | `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1` | unchanged |
| `--effort low\|medium\|high\|xhigh` | unchanged | that effort |

The two options are independent. The flavors behind them are generated into `team.yaml` from `workflows/flavors.yaml` (`bun run flavors`).

The model IDs are built into Pi 1.x (the proxy image mounts no `models.json`; a hand-written entry
would replace the built-in definition and its adaptive-thinking metadata). Catalogue presence
is not proof that an account can use a model. These two model/tool paths have
live receipts below; there is no fallback to an older model on failure.

The effort uses `provider_opts.extra_body.reasoning_effort`, not
`thinking_budget`: Docker Agent's OpenAI client does not map the latter for
Claude model IDs. The pinned Pi adapter otherwise sends `thinking: disabled`,
which Sonnet 5.5 rejects. Thinking is performed upstream; the OpenAI proxy does
not expose its thinking events to Docker Agent's UI.

The durable procedure is `instructions/reviewer.md`, loaded by native
`instruction_file`. `workflow.yaml` supplies the requested PR number. This is not
a Claude Code or Pi coding harness: Docker Agent owns the tools and review loop.

## Scope and output

The reviewer:

1. Calls `pr_context` before inspecting files. The helper reads GitHub metadata,
   requires local HEAD to equal the PR head, and refuses staged, unstaged or
   untracked changes. It returns a bounded overview: PR facts (body clipped to
   10 KB, at most 50 reported checks) and the pinned head/base/merge-base OIDs.
   The merge base is **PR-specific**, not the repository's default branch.
   It also reports the byte count, SHA-256 and page count of the full diff.
   `pr_diff` then returns the changed paths, diff stat and full diff one page at
   a time, at most 40 KB each. Docker Agent keeps only the **end** of a tool
   result over 51,200 bytes, which would drop the OIDs, so no result may be larger.
2. Reads changed code and relevant callers/tests/conventions using native
   read-only tools. It treats repository/PR content and CI status as untrusted
   evidence, not permission to run commands or disclose secrets.
3. Checks correctness, acceptance, errors, invariants/types, security, test
   quality, comment drift and scope. Findings need a concrete trigger, impact,
   narrow line citation and actionable correction. Existing guards must be
   accounted for; normal code and speculative future failures are not findings.
4. Repeats `pr_context` immediately before reporting. Head, base, merge base and
   the diff's SHA-256/size/page count must still match the original clean snapshot.
5. Posts the finished report with `pr_comment` (see [Posting the comment](#posting-the-comment)).

The local report begins with `VERDICT: Ship it`, `Approve-with-nits`, or
`Needs work`, followed by the PR URL and reviewed SHA, Overview, Findings,
Testing, Risks/limits and Out of scope. Any blocker or load-bearing finding
requires Needs work; only optional nits means Approve-with-nits.

A stale/dirty checkout, missing base history, unsafe instruction attempt or
materially incomplete evidence produces `BLOCKED` with an actionable reason and
**no verdict**. Docker Agent can exit 0 after an agent reports BLOCKED; inspect
the report, not just the process exit status. Do not turn this static review into
a passing-CI or runtime-verification claim.

## Enforced boundary versus policy

The offered tools are native read-only git operations, filesystem reads/listings/
searches restricted to `allow_list: ["."]`, and three typed script helpers:
`pr_context`, `pr_diff` and `pr_comment`. There is no general shell or filesystem
write/delete tool. The only GitHub write is `pr_comment`, a plain comment: no
approval, change request or edit. The filesystem restriction rejects absolute-path
and symlink escapes even under `--safety autonomous`.

The trusted context helper runs only fixed `gh pr view` and read-only git
commands. It disables external diff drivers, text conversion, fsmonitor hooks
and optional git locks. It never fetches, refreshes, resets or repairs a checkout,
and never executes PR code.

This is not an OS sandbox. Credential files committed or ignored **inside** an
allowed checkout remain within the filesystem boundary; avoiding their contents
and resisting prompt injection are reviewer policies, not a secret-filtering
guarantee. Do not place secrets in the review worktree. The launcher itself may
fetch refs and create a worktree before starting the read-only agent.

## Posting the comment

`pr_comment` is the reviewer's only write and the one tool not pre-approved in
`team.yaml`. In the interactive TUI a dialog shows the full comment text and asks
before each post (answer `T` to always allow it for the session). **Without a
terminal, `--exec` rejects it** ("The user rejected the tool call") and the
reviewer reports `Comment not posted`. For an unattended run that should post, use a queue
(`--queue`, `--queue-label` or `--queue-unreviewed`), which approves `pr_comment` for those runs
only; `-- --exec --safety autonomous` also works for a single run but approves every tool. It posts as the
account `gh` is using (`gh api user --jq .login`), with a short footer saying it
is a static review.

The helper refuses, and posts nothing, when:

- the text does not start with a `VERDICT:` line (a `BLOCKED` result is never posted)
  or has no `Reviewed head SHA:` line;
- the PR head is no longer the commit the report reviewed, or the checkout is dirty;
- the text exceeds 30,000 characters;
- it matches a credential pattern (private key block, API keys, GitHub/Slack tokens,
  AWS key IDs, JSON web tokens). This is a best-effort filter, not a guarantee.

**Risk:** the report is written by a model from untrusted PR content and can be read
by everyone with access to the repository. A malicious PR could try to make the
reviewer quote a file from the checkout. The refusals above and the reviewer's
instructions reduce this; they do not remove it. Read the text at the approval
prompt for PRs you do not trust, and do not keep secrets in the review worktree.

Posting twice creates two comments. A comment is not an approval and does not
replace the maintainers' review.

## Worktree limits

The entry uses `pr` mode with `detached: true`, creating
`<project>-pr-<number>-detached` beside the source checkout. New review worktrees
are detached at the freshly fetched PR head, so a PR branch already checked out
elsewhere is not claimed, moved or reset. An editable (attached) PR worktree, if a
team defines one, keeps its separate `<project>-pr-<number>` path and branch tracking.

An existing review worktree is moved to the freshly fetched PR head before each
run (`git -C <path> fetch origin <branch>`, then `checkout --detach FETCH_HEAD`), so a
PR that gained a commit is reviewed at its new head. If the worktree has uncommitted
changes that conflict with the new head, that step fails and the review does not
start; changes that do not conflict are carried over, and the context helper then
blocks on the dirty checkout rather than silently reviewing the wrong revision.
Preserve local changes outside the reviewer. If the PR base
object is absent, fetch that base/history yourself and rerun. Older branch-based
review worktrees are not converted or deleted automatically.

Inherited launcher restrictions apply: the PR head must uniquely identify a
branch in origin. Fork PRs, deleted branches and ambiguous branch heads are
refused. See [worktree modes](../../docs/launcher.md#worktree-modes).
Binary/generated changes or unavailable external requirements can also limit a
static review; missing essential evidence must not become an approval.

## Verification receipt

2026-10-15, Linux amd64, Docker Agent 1.145.0, proxy 4.9.5 / locked Pi adapter
0.73.1, with the versioned current-model catalogue:

- `bin/j5 pr-reviewer review --pr 12 --project <scratch> --print` printed the PR
  worktree preparation and native reviewer invocation.
- The same launcher path with `-- --dry-run --exec` created the scratch PR
  worktree and initialized successfully.
- A real `-- --exec --json --safety autonomous` review of
  [number-5 PR #12](https://github.com/vx-daniel/number-5/pull/12), head
  `1ee57cd9e899b22ec283bb18d37fd3bd7247f841`, ran on `pi/claude-sonnet-5-5`.
  Its actual calls were `pr_context`, `list_directory`, file reads/search, then
  `pr_context` again. It returned an SHA-identifying local report, exit 0, with
  the review worktree unchanged. Nothing was posted to GitHub.
- The old hand-written `low` flavor (Haiku 5.5, effort medium) ran on `pi/claude-haiku-5-5`; `--model haiku --effort medium` now selects the same pair. With an untracked local file added
  to the scratch worktree, it called only `pr_context`, returned BLOCKED with no
  verdict, and left the file intact.
- Real PR #124 of a private repository, whose diff does not fit in one tool result
  (the first design returned 110,548 bytes and lost its start): `pr_context` is
  10 KB, `pr_diff` returns two pages of 40 KB and 13 KB, and every page repeats the
  full diff's fingerprint. The pages reassemble to exactly the fingerprinted diff.
  The full Sonnet 5.5 review read both pages, repeated `pr_context`, and returned
  an SHA-identifying local report.
- A separate live Haiku 5.5 probe using the same filesystem allow-list attempted
  to read an actual external sentinel and an actual in-root symlink to it. Both
  calls returned `isError: true` / `outside the allowed directories (.)`; the
  sentinel content was not returned, even with autonomous tool approval.
- Sonnet 5.5/high and Haiku 5.5/medium each completed a separate two-turn native
  script-tool probe and returned both values generated by the executed tools.

These are exercised integration paths, not an accuracy benchmark, a proof of
prompt-injection immunity, or coverage of every model capability. Compaction,
long-running refresh, other models and GitHub publication are not verified here;
publication is deliberately not offered by this workflow.

Repository verification on the same date: `bun run check` passed with a
non-authenticating `PI_PROXY_AUTH_TOKEN=validation-only-no-model-calls` and a
temporary PowerShell 7.6.4 on PATH: 254 tests passed, 1 Windows-only test skipped;
typecheck, lint, formatting, shellcheck and all three team validations passed.
The 12 new real-git tests cover PR-specific scope, stale/dirty checkout refusal,
missing history, invalid numbers and disabled repository diff/fsmonitor drivers.

### Detached worktree regression

The initial branch-based reviewer could fail when the PR branch was already
checked out elsewhere. After enabling detached review worktrees, the affected
project's actual launcher command passed both `--print` and
`-- --dry-run --exec`: Git created a detached snapshot at the fetched head and
Docker Agent 1.145.0 reported `Dry run mode enabled. Agent initialized but will
not execute.` (exit 0). The source checkout's branch, HEAD and local status were
unchanged. This check prepared the review worktree; it did not run another model
review.

Real-git CLI regressions also exercise an occupied, stale local PR branch with
dirty files and prove that detached reviews do not replace the editable
branch-tracking follow-up worktree.

After this fix, the full `bun run check` passed again: 256 tests passed, 1
Windows-only test skipped, and all three teams validated. The added CLI
regressions run real git preparation while replacing only the model launcher.
