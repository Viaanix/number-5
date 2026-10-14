# Adding a team or an experiment

A team is a top-level directory. Copying `issue-team/` and cutting it down is usually faster than starting empty.

## Layout

```
my-team/
  team.yaml           docker-agent config: models, agents, toolsets, permissions, flavors
  workflow.yaml       launcher manifest: entry points, parameters, worktree mode, first message
  instructions/       one <agent>.md per agent (instruction_file)
  bin/                deterministic helpers exposed as script tools; listed in workflow.yaml `path`
  README.md           what it does, its agents, its limits
```

## Steps

1. **Write `team.yaml`.** Start from the patterns in [docker-agent/patterns.md](docker-agent/patterns.md). Check it parses: `docker agent debug config my-team/team.yaml`.
2. **Write `instructions/<agent>.md`** for each agent: the procedure, what every task message carries, the output format, and the rules (what it must never do).
3. **Move anything deterministic into `bin/`** and expose it as a `type: script` tool. Name helpers `<team>-<verb>` so two teams' helpers never shadow each other on `PATH`. Start each with `#!/usr/bin/env bash` and `set -euo pipefail`; `bun run lint:shell` finds them by shebang.
4. **Define effort levels** as `flavors:` if the team should have any. Keep each flavor to the keys it changes.
5. **Write `workflow.yaml`** ([schema](launcher.md#the-manifest-teamworkflowyaml)) with one entry point per way of starting the team.
6. **Check it:**
   ```bash
   bun run validate:teams                       # manifest rules, agents exist, configs parse, flavors change something, dry runs
   daw list                                     # it shows up
   daw my-team <entrypoint> --<param> … --print # the command is what you expect
   daw my-team <entrypoint> --<param> … -- --dry-run --exec   # docker-agent initializes it for real
   ```
7. **Run it for real** on a throwaway repository before pointing it at a project you care about.
8. **Write down what surprised you** in [docker-agent/gotchas.md](docker-agent/gotchas.md), with the receipt. A pattern a second team copies goes in [docker-agent/patterns.md](docker-agent/patterns.md).

## Experiments

An experiment that is not ready to be a team can live in its own top-level directory **without** a `workflow.yaml`; the launcher and `validate:teams` ignore it. Add the manifest when it should be launchable. Record what the experiment taught you in `docs/`, whether or not it survives.
