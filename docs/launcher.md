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
j5 list                                    # teams, entry points, parameters, efforts
j5 setup                                   # check this machine, install the skills ([packaging.md](packaging.md#what-j5-setup-does))
j5 --version                               # the installed version
j5 issue-team work-issue --issue 123       # from inside the project checkout
j5 issue-team work-issue --issue 123 --project ~/code/app --effort low
j5 issue-team work-issue --issue 123 --base origin/release-2
j5 pr-reviewer review --pr 456 -- --safety balanced   # after --: raw docker agent run flags
j5 issue-team work-issue --issue 123 --print    # show the exact command, run nothing
```

| Option | Meaning | Default |
|---|---|---|
| `--project <path>` | Checkout the team works on; any path inside a git repository | The repository around the current directory, any subdirectory; asked for only when you are not in one |
| `--base <ref>` | Ref a `new` worktree branches from. Only for `new` worktrees | The remote default branch (`origin/HEAD`, else `gh`) |
| `--effort <flavor>` | A `flavors:` key from the team's `team.yaml`, passed as `--flavor` | None: the team as written |
| `--<parameter> <value>` | The entry point's parameters, e.g. `--issue 123` | Asked for, or an error when not in a terminal |
| `--queue <n,n,…>` | Run the entry point once per value, unattended ([queue runs](#queue-runs)). Only entry points with a `queue:` block | |
| `--queue-label <label>` | The same, over every open issue with this label, oldest first. Needs a `gh` login (or `GH_TOKEN`) that can see the repository | |
| `--max-rounds <n\|none>` | Fix rounds per queue item; `none` for no limit | 5 |
| `--print` | Print the command as one line instead of running it: bash/zsh syntax on Linux and macOS, PowerShell on Windows. A queue prints one line per item | |
| `-- …` | Everything after a bare `--` is appended to `docker agent run` | |

Anything missing is asked for when stdin and stdout are a terminal; otherwise it is an error (exit 2). When anything was asked, the command is shown and confirmed before it runs. Ctrl-C at a prompt exits 130 and launches nothing. Once docker-agent is running, Ctrl-C belongs to its TUI.

The base-branch list shows remote branches as of your last `git fetch`. `j5` fetches the chosen base before it creates the worktree.

## What it runs

`j5 issue-team work-issue --issue 12 --effort low --print`, inside a clone at `~/code/my-app` (the message, the whole prompt, shortened here):

```bash
git -C ~/code/my-app fetch origin main && git -C ~/code/my-app worktree add -b worktree-my-app-issue-12 ~/code/my-app-issue-12 origin/main && cd ~/code/my-app-issue-12 && PATH=<repo>/workflows/issue-team/bin:"$PATH" docker agent run <repo>/workflows/issue-team/team.yaml --agent root --flavor low --working-dir ~/code/my-app-issue-12 'Work issue #12. …'
```

`j5` creates the worktree itself and starts docker-agent inside it with `--working-dir`. docker-agent's own `--worktree` / `--worktree-pr` create a worktree but leave a Claude Code harness agent in your checkout ([gotcha](docker-agent/gotchas.md#--worktree-does-not-move-a-harness-agent-into-the-worktree)). The git steps run before docker-agent and stop it from starting if one fails. `--print` runs none of them; on Windows its output chains them with `&&`, which needs PowerShell 7+.

## Queue runs

`j5 issue-team work-issue --queue 474,480,482 --max-rounds 5` (or `--queue-label ready`) runs the entry point once per issue, one after another, **unattended**:

- Each item gets its own worktree, exactly as a single run would, and runs `docker agent run … --exec`: no TUI, nobody to answer. The entry point's `queue.preamble` goes before its prompt and says so (issue-team's tells the agent to decide where it would have asked, and to explain each decision in the PR, replaces its fix-round limit with `--max-rounds` (5 when not given), says that on hitting the limit or a round with no progress it publishes a **draft** PR and ends with `RESULT: FAILED draft PR <url>: <reason>`, and otherwise asks for a last line `RESULT: PR <url>` or `RESULT: FAILED <reason>`).
- Each item's output is shown live and saved to `<project>/.j5/queue/<start time>/issue-<n>.log`; `summary.md` in the same directory lists every item's outcome.
- **The outcome comes from the `RESULT:` line**, never the exit code: `docker agent run --exec` exits 0 whenever the agent finishes its turn. No `RESULT:` line means the item failed.
- An item that fails (including a failed git step, e.g. its branch already exists) is reported and the queue goes on. An item whose agent could not run at all (docker-agent printed `harness … failed` or `model failed:`, e.g. the Claude session limit) **stops the queue**, since every later item would fail the same way. Ctrl-C stops it after the current item.
- `j5` exits 0 only when every item opened a pull request, 1 otherwise. A draft PR therefore counts as a failed item in the exit code and the summary.
- In a terminal, an entry point with a queue that gets neither `--<parameter>` nor `--queue` / `--queue-label` asks whether to run one item, a list, or a label. `--print` runs nothing and creates no log directory; `--queue-label` still asks GitHub for the issues.

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

**Harness versus native prompts.** For test-quality, a Claude Code harness team, the message is the whole prompt because Docker Agent gives a harness agent nothing else; use a YAML block (`message: |`). Native agents such as issue-team and pr-reviewer load a durable `instruction_file` from `team.yaml` and use the manifest message for task parameters. `--print` shows the manifest message, not native instruction-file contents.

**Worktree modes.**

Worktrees go **beside the project**: `<parent of the checkout>/<name>`, e.g. `~/code/my-app-issue-12` for `~/code/my-app`. A path that already holds a linked worktree of the same repository is continued as it is, with no git step; anything else there is refused.

| Mode | Worktree, branch | What `j5` runs first | Use for |
|---|---|---|---|
| `new` | `worktree.name` from the template; branch `worktree-<name>` | `git fetch origin <base>` (for an `origin/…` base), `git worktree add -b worktree-<name> <path> <base>` | Fresh work from a base branch |
| `pr` | `<repo>-pr-<n>`; the PR's own branch, tracking `origin/<branch>` | `git fetch origin <branch>`, `git worktree add --track -b <branch> <path> origin/<branch>` (or `git worktree add <path> <branch>` when that local branch exists). Needs `pull_request_parameter: <an integer parameter>` | Continuing a pull request's branch |
| `pr` with `detached: true` | `<repo>-pr-<n>-detached`; detached HEAD at the fetched PR head | `git fetch origin <branch>`, then `git worktree add --detach <path> FETCH_HEAD` | Read-only reviews without claiming the PR branch |
| `none` | none; runs in the checkout itself | nothing | Read-only, conversational, or in-place entry points |

`detached` is an optional boolean on a `pr` worktree definition; omitted or false
keeps the editable behavior. pr-reviewer sets it to true. Its separate directory
prevents an editable follow-up workflow from reusing a detached review snapshot.
The fresh fetch, not a possibly stale local branch, selects the review commit.
A detached snapshot does not require moving a branch checked out elsewhere.
Existing worktrees are still reused as-is, with no automatic refresh/reset.

**Finding a PR's branch** uses git alone, so it works over an SSH remote with no `gh` login: `git ls-remote origin refs/pull/<n>/head` gives the PR's head commit, and the PR's branch is the one origin branch whose tip is that commit. A PR from a fork (its head is no origin branch), a merged PR whose branch was deleted, and a head shared by several branches are refused with a message. This lookup also runs for `--print` (read-only, needs the network).

A `new` worktree whose branch `worktree-<name>` already exists without the directory (e.g. the directory was deleted, or an older docker-agent worktree elsewhere holds it) stops at `git worktree add`; delete the branch or remove that worktree first.

**Reserved parameter names:** `repo`, `position`, `count`, `round_limit`, `project`, `base`, `effort`, `queue`, `queue-label`, `max-rounds`, `print`, `help`, `version`, `check`, `proxy`, `login`.

**Independence.** A team where one agent reviews the work of others can say so:

```yaml
independence:
  reviewer: reviewer             # the agent whose model class must differ
  reviews: [builder, tester]     # from each of these agents' (all named in team.yaml)
```

"Class" is the model's tier: `haiku`, `sonnet`, `opus` or `fable`, whatever the version (Sonnet 5.5 and Sonnet 4.6 are one class). Before it creates any worktree, `j5` reads the models the agents run on with the chosen `--effort` applied (`docker agent debug config`), puts the reviewer **one tier above the highest builder tier** (the nearest tier the team offers above it; one tier below when nothing is above, so a Fable builder gets an Opus reviewer), and passes the matching `reviewer-on-<tier>` flavor after the effort. It prints one line saying what it chose. The team offers tiers by defining flavors named `reviewer-on-<tier>` in team.yaml, each patching the reviewer's model. Those flavors are not efforts: they are not listed and `--effort reviewer-on-opus` is rejected.

`j5` refuses to launch when no offered tier differs from the builders', when a model's id names no tier, or when `--model` or `--flavor` follows `--` (`docker agent debug config` has no `--model`, so such an override would change the models after the rule was checked). `bun run validate:teams` checks every `reviewer-on-<tier>` flavor and every effort. Logic: `launcher/src/independence.ts`, `reviewer-flavor.ts`.

**Queue block.** An entry point can also run over a queue:

```yaml
    queue:
      parameter: issue            # an integer parameter; each queue value fills it
      preamble: |                 # goes before `message` for every item
        UNATTENDED QUEUE RUN — issue {issue}, item {position} of {count}. … Fix rounds: {round_limit}. …
```

The preamble may use the parameters, `{repo}`, and three placeholders only it has: `{position}` and `{count}` (where the item stands) and `{round_limit}` (`at most 3 fix rounds`, or `no limit on the number of fix rounds`).

**Effort** is not declared in the manifest. The valid values are the `flavors:` keys in `team.yaml`, read at launch, because docker-agent silently ignores unknown flavors ([gotcha](docker-agent/gotchas.md#an-unknown---flavor-is-silently-ignored)).

`bun run validate:teams` checks every manifest against its team.yaml and the installed docker-agent.
