# The `j5` launcher

One command to start any team in this repository against any project checkout. It picks the team, entry point, project, base branch, effort and parameters — from flags, or by asking — and runs `docker agent run` with the team's helper scripts on `PATH`.

Source: `launcher/src/` (start at `cli.ts`). Entry points: `bin/j5` (Linux, macOS), `bin/j5.cmd` (Windows), and the `j5` command Bun creates when number-5 is installed as a package ([packaging.md](packaging.md)). Install from a clone: `scripts/install.ts`.

## Install from a clone

```bash
bun scripts/install.ts                 # link + j5 in your shell's startup file + bun install if needed
bun scripts/install.ts --dry-run       # show what it would do
bun scripts/install.ts --link ~/agents --alias agents   # other link path / command name
bun scripts/install.ts --shell zsh     # configure another shell than $SHELL
bun scripts/install.ts --uninstall
```

| OS / shell | Link | Startup file | Command |
|---|---|---|---|
| Linux, bash | symlink | `~/.bash_aliases` if `~/.bashrc` sources it, else `~/.bashrc` | `alias j5=<link>/bin/j5` |
| macOS, bash | symlink | `~/.bash_profile` | `alias j5=<link>/bin/j5` |
| Linux/macOS, zsh | symlink | `~/.zshrc` | `alias j5=<link>/bin/j5` |
| Windows, PowerShell | directory junction (no admin rights needed) | `$PROFILE` | `function j5 { & bun <link>\launcher\src\cli.ts @args }` |

The command goes through the link, so moving the clone only needs a re-run of the installer. `bin\j5.cmd` serves cmd.exe users on Windows; the PowerShell function calls bun directly so Ctrl-C inside the agent does not trigger cmd's "Terminate batch job (Y/N)?". The alias block sits between `# >>> number-5 launcher >>>` markers; re-running replaces it.

## Use

```bash
j5                                         # pick everything interactively
j5 list                                    # teams, entry points, parameters, models, efforts
j5 setup                                   # check this machine, install the skills ([packaging.md](packaging.md#what-j5-setup-does))
j5 --version                               # the installed version
j5 issue-team work-issue --issue 123       # from inside the project checkout
j5 issue-team work-issue --issue 123 --project ~/code/app --model haiku --effort medium
j5 issue-team work-issue --issue 123 --base origin/release-2
j5 pr-reviewer review --pr 456 -- --safety balanced   # after --: raw docker agent run flags
j5 issue-team work-issue --issue 123 --print    # show the exact command, run nothing
```

| Option | Meaning | Default |
|---|---|---|
| `--project <path>` | Checkout the team works on; any path inside a git repository | The repository around the current directory, any subdirectory; asked for only when you are not in one |
| `--base <ref>` | Ref a `new` worktree branches from. Only for `new` worktrees | The remote default branch (`origin/HEAD`, else `gh`) |
| `--model <tier>` | Model tier for the team's builders, `haiku`, `sonnet` or `opus` as the team offers; passed as `--flavor model-<tier>` ([flavors](#model-and-effort-flavors)) | None: the team as written |
| `--effort <level>` | Reasoning effort, `low`, `medium`, `high` or `xhigh` as the team offers; passed as `--flavor effort-<level>`. Independent of `--model` | None: the team as written |
| `--<parameter> <value>` | The entry point's parameters, e.g. `--issue 123` | Asked for, or an error when not in a terminal |
| `--queue <n,n,…>` | Run the entry point once per value, unattended ([queue runs](#queue-runs)). Only entry points with a `queue:` block | |
| `--queue-label <label>` | The same, over every open issue (or, for a queue of pull requests, every open pull request) with this label, oldest first. Needs a `gh` login (or `GH_TOKEN`) that can see the repository | |
| `--queue-unreviewed` | The same, over every open, non-draft pull request this `gh` account has not reviewed at its current head commit, oldest first. Only for a queue of pull requests ([below](#pull-request-queues)) | |
| `--max-rounds <n\|none>` | Fix rounds per queue item; `none` for no limit | 5 |
| `--print` | Print the command as one line instead of running it: bash/zsh syntax on Linux and macOS, PowerShell on Windows. A queue prints one line per item | |
| `-- …` | Everything after a bare `--` is appended to `docker agent run` | |

Anything missing is asked for when stdin and stdout are a terminal; otherwise it is an error (exit 2). When anything was asked, the command is shown and confirmed before it runs. Ctrl-C at a prompt exits 130 and launches nothing. Once docker-agent is running, Ctrl-C belongs to its TUI.

The base-branch list shows remote branches as of your last `git fetch`. `j5` fetches the chosen base before it creates the worktree.

## What it runs

`j5 issue-team work-issue --issue 12 --model haiku --print`, inside a clone at `~/code/my-app` (the message, the whole prompt, shortened here; the second `--flavor` is the reviewer's tier, chosen by `j5`, see *Independence*):

```bash
git -C ~/code/my-app fetch origin main && git -C ~/code/my-app worktree add -b worktree-my-app-issue-12 ~/code/my-app-issue-12 origin/main && cd ~/code/my-app-issue-12 && PATH=<repo>/workflows/issue-team/bin:"$PATH" docker agent run <repo>/workflows/issue-team/team.yaml --agent root --flavor model-haiku --flavor reviewer-on-sonnet --working-dir ~/code/my-app-issue-12 'Work issue #12. …'
```

`j5` creates the worktree itself and starts docker-agent inside it with `--working-dir`. docker-agent's own `--worktree` / `--worktree-pr` create a worktree but leave a Claude Code harness agent in your checkout ([gotcha](docker-agent/gotchas.md#--worktree-does-not-move-a-harness-agent-into-the-worktree)). The git steps run before docker-agent and stop it from starting if one fails. `--print` runs none of them; on Windows its output chains them with `&&`, which needs PowerShell 7+.

## Queue runs

`j5 issue-team work-issue --queue 474,480,482 --max-rounds 5` (or `--queue-label ready`) runs the entry point once per issue, one after another, **unattended**:

- Each item gets its own worktree, exactly as a single run would, and runs `docker agent run … --exec`: no TUI, nobody to answer. The entry point's `queue.preamble` goes before its prompt and says so (issue-team's tells the agent to decide where it would have asked, and to explain each decision in the PR, replaces its fix-round limit with `--max-rounds` (5 when not given), says that on hitting the limit or a round with no progress it publishes a **draft** PR and ends with `RESULT: FAILED draft PR <url>: <reason>`, and otherwise asks for a last line `RESULT: PR <url>` or `RESULT: FAILED <reason>`).
- Each item's output is shown live and saved to `<project>/.j5/queue/<start time>/issue-<n>.log`; `summary.md` in the same directory lists every item's outcome.
- **The outcome comes from the `RESULT:` line**, never the exit code: `docker agent run --exec` exits 0 whenever the agent finishes its turn. No `RESULT:` line means the item failed. The forms are `RESULT: PR <url>`, `RESULT: DONE <what was done>` (for a team whose work is not a pull request, such as [triage](../workflows/triage/README.md)) and `RESULT: FAILED <reason>`.
- An item that fails (including a failed git step, e.g. its branch already exists) is reported and the queue goes on. An item whose agent could not run at all (docker-agent printed `harness … failed` or `model failed:`, e.g. the Claude session limit) **stops the queue**, since every later item would fail the same way. Ctrl-C stops it after the current item.
- `j5` exits 0 only when every item opened a pull request or finished with `RESULT: DONE`, 1 otherwise. A draft PR therefore counts as a failed item in the exit code and the summary. The summary's headline stays "N of M opened a pull request." unless an item was `DONE`, then it counts both.
- In a terminal, an entry point with a queue that gets neither `--<parameter>` nor `--queue` / `--queue-label` / `--queue-unreviewed` asks whether to run one item, a list, a label, or (for a queue of pull requests) the unreviewed pull requests. `--print` runs nothing and creates no log directory; `--queue-label` and `--queue-unreviewed` still ask GitHub.

### Pull request queues

`j5 pr-reviewer review --queue-unreviewed` reviews every open pull request that has not been reviewed since its last commit, and posts each review as a comment. It is meant to run on a schedule: a run with nothing to review prints `no open pull request needs a review` and exits 0.

- **"Reviewed" means a stamp, not a guess.** Every posted review carries a `Reviewed head SHA: <commit>` line (`pr_comment` refuses a report without it, and both sides read it through `launcher/src/review-status.ts`). A pull request is queued when it is not a draft and none of **the logged-in `gh` account's own comments** carries a stamp for its current head. Pushing a commit changes the head, so the pull request comes back. Comments by other accounts are ignored, so nobody can keep a pull request out of the queue by quoting its head commit.
- **A review by a different account does not count.** The stamp is matched against the account `gh api user` reports, which is the account `pr_comment` posts as. A repository whose reviews are posted by one account and queued by another would be re-reviewed on every run.
- **`gh pr list` returns at most 200 pull requests.** A repository with that many open refuses the listing (it would skip the oldest silently); name the ones you want with `--queue` or `--queue-label`.
- **Posting is approved for queue runs only.** `--exec` rejects a tool nobody can approve, and `pr_comment` is the one tool pr-reviewer leaves unapproved so a person confirms each post. The manifest's `queue.approves: [pr_comment]` makes j5 add the generated `queue-unattended` flavor to each queued run (and only to those), which approves that tool on top of team.yaml's own list. A single `--pr` run still asks.
- A fork's pull request, whose head is no branch of this repository, fails its own item (the worktree step refuses it) and the queue goes on.

## The manifest: `workflows/<team>/workflow.yaml`

A directory under `workflows/` with a `workflow.yaml` is a team; there is no registry. Top-level directories are never teams. docker-agent never reads this file.

```yaml
name: issue-team                 # what you type after j5; unique
description: One line for `j5 list` and the picker
team: team.yaml                  # the docker-agent config, relative to this file
path: [bin]                      # directories prepended to PATH (script tools call helpers by name)

entrypoints:
  work-issue:                    # what you type after the team name
    description: One line
    agent: root                  # must exist in team.yaml (checked: docker-agent's dry run does not)
    parameters:                  # each becomes --<name>; lowercase-hyphenated
      issue: { type: integer, label: Issue number }   # integer = positive, no leading zero; or string
    worktree:
      mode: new                  # new | pr | none
      name: "{repo}-issue-{issue}"
    message: "Work issue #{issue}"   # the first user message
```

**Templates.** `message` and `worktree.name` take `{placeholder}`s: any parameter, plus `{repo}` (the project's directory name). An unknown placeholder is a manifest error, never literal text in a prompt. `{{` and `}}` are literal braces, e.g. `gh api repos/{{owner}}/{{repo}}/pulls/{pr}` sends `repos/{owner}/{repo}/pulls/7`.

**Native versus harness prompts.** Native agents (every team here) load a durable `instruction_file` from `team.yaml` and use the manifest message for the task's parameters; `--print` shows the manifest message, not the instruction-file contents. A `harness: claude-code` agent would get nothing but the message, so its whole procedure would go there (use a YAML block, `message: |`); no team uses one now.

**Worktree modes.**

Worktrees go **beside the project**: `<parent of the checkout>/<name>`, e.g. `~/code/my-app-issue-12` for `~/code/my-app`. A path that already holds a linked worktree of the same repository is continued as it is, with no git step (a detached review snapshot is the one exception, below); anything else there is refused.

| Mode | Worktree, branch | What `j5` runs first | Use for |
|---|---|---|---|
| `new` | `worktree.name` from the template; branch `worktree-<name>` | `git fetch origin <base>` (for an `origin/…` base), `git worktree add -b worktree-<name> <path> <base>` | Fresh work from a base branch |
| `pr` | `<repo>-pr-<n>`; the PR's own branch, tracking `origin/<branch>` | `git fetch origin <branch>`, `git worktree add --track -b <branch> <path> origin/<branch>` (or `git worktree add <path> <branch>` when that local branch exists). Needs `pull_request_parameter: <an integer parameter>` | Continuing a pull request's branch |
| `pr` with `detached: true` | `<repo>-pr-<n>-detached`; detached HEAD at the fetched PR head | `git fetch origin <branch>`, then `git worktree add --detach <path> FETCH_HEAD`; for a snapshot that already exists, `git -C <path> fetch origin <branch>`, then `git -C <path> checkout --detach FETCH_HEAD` | Read-only reviews without claiming the PR branch |
| `none` | none; runs in the checkout itself | nothing | Read-only, conversational, or in-place entry points |

`detached` is an optional boolean on a `pr` worktree definition; omitted or false
keeps the editable behavior. pr-reviewer sets it to true. Its separate directory
prevents an editable follow-up workflow from reusing a detached review snapshot.
The fresh fetch, not a possibly stale local branch, selects the review commit.
A detached snapshot does not require moving a branch checked out elsewhere.
Other existing worktrees are still reused as-is, with no automatic refresh/reset. A kept
detached snapshot is the exception: it exists to be the PR's head, so it is moved to the
freshly fetched head before each run (the fetch runs inside it, because `FETCH_HEAD` is per
worktree). Reusing it as it was left made a PR that gained a commit fail its next review as
stale, which a review queue hits every time. A snapshot with uncommitted changes that conflict
with the new head fails that step and the run does not start.

**Finding a PR's branch** uses git alone, so it works over an SSH remote with no `gh` login: `git ls-remote origin refs/pull/<n>/head` gives the PR's head commit, and the PR's branch is the one origin branch whose tip is that commit. A PR from a fork (its head is no origin branch), a merged PR whose branch was deleted, and a head shared by several branches are refused with a message. This lookup also runs for `--print` (read-only, needs the network).

A `new` worktree whose branch `worktree-<name>` already exists without the directory (e.g. the directory was deleted, or an older docker-agent worktree elsewhere holds it) stops at `git worktree add`; delete the branch or remove that worktree first.

**Reserved parameter names:** `repo`, `position`, `count`, `round_limit`, `project`, `base`, `model`, `effort`, `queue`, `queue-label`, `queue-unreviewed`, `max-rounds`, `print`, `help`, `version`, `check`, `proxy`, `login`.

**Independence.** A team where one agent reviews the work of others can say so:

```yaml
independence:
  reviewer: reviewer             # the agent whose model class must differ
  reviews: [builder, tester]     # from each of these agents' (all named in team.yaml)
```

"Class" is the model's tier: `haiku`, `sonnet`, `opus` or `fable`, whatever the version (Sonnet 5.5 and Sonnet 4.6 are one class). Before it creates any worktree, `j5` reads the models the agents run on with the chosen `--model` and `--effort` applied (`docker agent debug config`), puts the reviewer **one tier above the highest builder tier** (the nearest tier the team offers above it; one tier below when nothing is above, so a Fable builder gets an Opus reviewer), and passes the matching `reviewer-on-<tier>` flavor after them. It prints one line saying what it chose. The team offers tiers by having flavors named `reviewer-on-<tier>` in team.yaml, each patching the reviewer's model (generated, see below). Those flavors are not a user choice: `--model` and `--effort` reject them.

`j5` refuses to launch when no offered tier differs from the builders', when a model's id names no tier, or when `--model` or `--flavor` follows `--` (`docker agent debug config` has no `--model`, so such an override would change the models after the rule was checked). `bun run validate:teams` checks every `reviewer-on-<tier>` flavor and every combination of `--model` and `--effort`. Logic: `launcher/src/independence.ts`, `reviewer-flavor.ts`.

### Model and effort flavors

Every team offers the same two launch options, `--model <tier>` and `--effort <level>`, as standard flavors named `model-<tier>` and `effort-<level>`. docker-agent has no include or import for flavors (they live in each `team.yaml`; its own idea of reuse is the same names in every file), so they are defined once and **generated**:

- `workflows/flavors.yaml` is the catalog: which model id each tier means (`haiku`, `sonnet`, `opus`) and which efforts exist (`low`, `medium`, `high`, `xhigh`).
- A team's `workflow.yaml` says which of its named models the options change:

  ```yaml
  flavors:
    models: [coordinator_model, builder_model, tester_model]
  ```

  `--model` puts exactly these on the chosen tier. `--effort` sets their `reasoning_effort` and the independence reviewer's too. The reviewer's own model is never listed: its tier is `j5`'s choice.
- `bun run flavors` writes the flavors into the block between `# BEGIN GENERATED FLAVORS` and `# END GENERATED FLAVORS` at the end of the team's `team.yaml` (`bun run flavors --check` changes nothing and exits 1 when a block is stale). Edit the catalog or the manifest, never the block.

`--model` and `--effort` combine in either order (they patch different keys), and with neither, the team runs as `team.yaml` is written. Passing only `--effort low` therefore changes reasoning effort and nothing else; it no longer means "the cheap preset". Whether two levels differ upstream depends on the proxy image: with the 4.9.5 image `xhigh` equals `high` on Sonnet and Haiku, and with 4.9.6-1 and later all four levels are distinct ([gotcha](docker-agent/gotchas.md#our-modelsjson-entries-replace-pis-built-in-model-definitions-and-with-them-adaptive-effort)). `bun run validate:teams` fails when a block is out of date, when a flavor's merged config does not do what its name says, and for any flavor name no option can reach. Logic: `launcher/src/flavor-catalog.ts`, `scripts/generate-flavors.ts`.

**Proxy image check.** The `opus` and `fable` tiers need proxy image 4.9.6-1 or later. Before a launch that is not `--print`, `j5` finds the running proxy container by its Compose labels and compares its image with the `image:` tag in the `compose.yaml` that ships with this `j5`; on a difference it prints a `j5: warning:` line and carries on. `j5 setup --check --proxy` and a real `j5 setup --proxy` report the same comparison. "Latest" means that pinned tag, not a registry lookup, and anything the check cannot learn (no Docker, no proxy container) prints nothing. Logic: `launcher/src/proxy-image.ts`.

**Queue block.** An entry point can also run over a queue:

```yaml
    queue:
      parameter: issue            # an integer parameter; each queue value fills it
      items: issues               # or pull-requests: what the numbers are (default issues)
      approves: []                # tools the queue's unattended runs may call that team.yaml does not pre-approve
      preamble: |                 # goes before `message` for every item
        UNATTENDED QUEUE RUN — issue {issue}, item {position} of {count}. … Fix rounds: {round_limit}. …
```

The preamble may use the parameters, `{repo}`, and three placeholders only it has: `{position}` and `{count}` (where the item stands) and `{round_limit}` (`at most 3 fix rounds`, or `no limit on the number of fix rounds`).

`items` decides what `--queue-label` lists and whether `--queue-unreviewed` is allowed (pull requests only). `approves` names tools for the generated `queue-unattended` flavor, which j5 adds to every queued run of the entry point: its `permissions.allow` is team.yaml's own list plus these tools, because a list in a flavor replaces the base list ([gotcha](docker-agent/gotchas.md#a-list-in-a-flavor-replaces-the-base-list-it-does-not-extend-it)). It needs the manifest's `flavors:` block, and `bun run validate:teams` checks the merged result.

**Effort and model** are not declared in the manifest. The valid values are the `model-*` and `effort-*` flavor names in `team.yaml`, read at launch, because docker-agent silently ignores unknown flavors ([gotcha](docker-agent/gotchas.md#an-unknown---flavor-is-silently-ignored)).

`bun run validate:teams` checks every manifest against its team.yaml and the installed docker-agent.
