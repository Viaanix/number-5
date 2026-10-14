# The `daw` launcher

One command to start any team in this repository against any project checkout. It picks the team, entry point, project, base branch, effort and parameters — from flags, or by asking — and runs `docker agent run` with the team's helper scripts on `PATH`.

Source: `launcher/src/` (start at `cli.ts`). Entry points: `bin/daw` (Linux, macOS), `bin/daw.cmd` (Windows). Install: `scripts/install.ts`.

## Install

```bash
bun scripts/install.ts                 # link + daw in your shell's startup file + bun install if needed
bun scripts/install.ts --dry-run       # show what it would do
bun scripts/install.ts --link ~/agents --alias agents   # other link path / command name
bun scripts/install.ts --shell zsh     # configure another shell than $SHELL
bun scripts/install.ts --uninstall
```

| OS / shell | Link | Startup file | Command |
|---|---|---|---|
| Linux, bash | symlink | `~/.bash_aliases` if `~/.bashrc` sources it, else `~/.bashrc` | `alias daw=<link>/bin/daw` |
| macOS, bash | symlink | `~/.bash_profile` | `alias daw=<link>/bin/daw` |
| Linux/macOS, zsh | symlink | `~/.zshrc` | `alias daw=<link>/bin/daw` |
| Windows, PowerShell | directory junction (no admin rights needed) | `$PROFILE` | `function daw { & bun <link>\launcher\src\cli.ts @args }` |

The command goes through the link, so moving the clone only needs a re-run of the installer. `bin\daw.cmd` serves cmd.exe users on Windows; the PowerShell function calls bun directly so Ctrl-C inside the agent does not trigger cmd's "Terminate batch job (Y/N)?". The alias block sits between `# >>> docker-agent-workflows launcher >>>` markers; re-running replaces it.

## Use

```bash
daw                                         # pick everything interactively
daw list                                    # teams, entry points, parameters, efforts
daw issue-team work-issue --issue 123       # from inside the project checkout
daw issue-team work-issue --issue 123 --project ~/code/app --effort low
daw issue-team work-issue --issue 123 --base origin/release-2
daw issue-team pr-followup --pr 456 -- --safety balanced   # after --: raw docker agent run flags
daw issue-team closeout --pr 456 --print    # show the exact command, run nothing
```

| Option | Meaning | Default |
|---|---|---|
| `--project <path>` | Checkout the team works on; any path inside a git repository | The repository around the current directory, any subdirectory; asked for only when you are not in one |
| `--base <ref>` | Ref a `new` worktree branches from. Only for `new` worktrees | The remote default branch (`origin/HEAD`, else `gh`) |
| `--effort <flavor>` | A `flavors:` key from the team's `team.yaml`, passed as `--flavor` | None: the team as written |
| `--<parameter> <value>` | The entry point's parameters, e.g. `--issue 123` | Asked for, or an error when not in a terminal |
| `--print` | Print the command as one line instead of running it: bash/zsh syntax on Linux and macOS, PowerShell on Windows | |
| `-- …` | Everything after a bare `--` is appended to `docker agent run` | |

Anything missing is asked for when stdin and stdout are a terminal; otherwise it is an error (exit 2). When anything was asked, the command is shown and confirmed before it runs. Ctrl-C at a prompt exits 130 and launches nothing. Once docker-agent is running, Ctrl-C belongs to its TUI.

The base-branch list shows remote branches as of your last `git fetch`. docker-agent fetches the chosen base itself before branching.

## What it runs

`daw issue-team work-issue --issue 12 --effort low --print`, inside a clone named `my-app`:

```bash
cd /path/to/my-app && PATH=<repo>/issue-team/bin:"$PATH" docker agent run <repo>/issue-team/team.yaml --agent root --flavor low --worktree=my-app-issue-12 --worktree-base origin/main 'Work issue #12'
```

## The manifest: `<team>/workflow.yaml`

A top-level directory with a `workflow.yaml` is a team; there is no registry. docker-agent never reads this file.

```yaml
name: issue-team                 # what you type after daw; unique
description: One line for `daw list` and the picker
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

**Templates.** `message` and `worktree.name` take `{placeholder}`s: any parameter, plus `{repo}` (the project's directory name). An unknown placeholder is a manifest error, never literal text in a prompt.

**Worktree modes.**

| Mode | docker-agent flags | Use for |
|---|---|---|
| `new` | `--worktree=<name> --worktree-base <base>` | Fresh work from a base branch |
| `pr` | `--worktree-pr <n>`, or `--working-dir ~/.cagent/worktrees/pr-<n>` when that worktree is kept and has this project's `origin`. Refused when it belongs to another repository. Needs `pull_request_parameter: <an integer parameter>` | Continuing a pull request's branch |
| `none` | none; runs in the checkout itself | Read-only or conversational entry points |

**Reserved parameter names:** `repo`, `project`, `base`, `effort`, `print`, `help`.

**Effort** is not declared in the manifest. The valid values are the `flavors:` keys in `team.yaml`, read at launch, because docker-agent silently ignores unknown flavors ([gotcha](docker-agent/gotchas.md#an-unknown---flavor-is-silently-ignored)).

`bun run validate:teams` checks every manifest against its team.yaml and the installed docker-agent.
