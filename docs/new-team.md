# Adding a team or an experiment

A team is a directory under `workflows/`. Copying `workflows/issue-team/` and cutting it down is usually faster than starting empty.

## Layout

```
workflows/my-team/
  team.yaml           docker-agent config: agents (harness: claude-code), flavors
  workflow.yaml       launcher manifest: entry points, parameters, worktree mode, and each entry agent's whole prompt as its message
  roles/              optional: sub-agent role prompts shared by several entry points, printed by a <team>-role helper
  helpers/            deterministic Bun scripts the agents run by bare name
  bin/                one sh + one .cmd launcher per helper; listed in workflow.yaml `path`
  README.md           what it does, its agents, its limits
```

## Steps

1. **Write `team.yaml`**: one `harness: claude-code` agent per entry point (no API key needed; see [patterns](docker-agent/patterns.md) for what a harness agent does not get). Check it parses: `docker agent debug config workflows/my-team/team.yaml`.
2. **Write each entry agent's prompt as its entry point's `message`** in `workflow.yaml`: the procedure, what every sub-agent task carries, the output format, and the rules (what it must never do). `{param}` fills a parameter; write `{{` and `}}` for literal braces.
3. **Move anything deterministic into a helper** that the prompt tells the agent to run by bare name (the helper reads its arguments from the command line or the environment). Write it as `helpers/<verb>.ts`, using `runHelper` and `readToolArgument` from `launcher/src/team-helper.ts`; logic another team already has (the change diff, the test pre-screen) is a function in `launcher/src/` to call, not code to copy. Copy a launcher pair from `workflows/issue-team/bin/` as `bin/<team>-<verb>` and `bin/<team>-<verb>.cmd`. The `<team>-` prefix keeps two teams' helpers from shadowing each other on `PATH`. Never name a tool argument `path`: arguments reach the helper as environment variables, and on Windows `path` is `PATH`. See [patterns](docker-agent/patterns.md#helpers-that-run-on-every-os).
4. **Define effort levels** as `flavors:` (for harness agents, `harness.effort`) if the team should have any. Keep each flavor to the keys it changes.
5. **Write `workflow.yaml`** ([schema](launcher.md#the-manifest-workflowsteamworkflowyaml)) with one entry point per way of starting the team.
6. **Check it:**
   ```bash
   bun run validate:teams                       # manifest rules, agents exist, configs parse, flavors change something, dry runs
   j5 list                                     # it shows up
   j5 my-team <entrypoint> --<param> … --print # the command is what you expect
   j5 my-team <entrypoint> --<param> … -- --dry-run --exec   # docker-agent initializes it for real
   ```
7. **Run it for real** on a throwaway repository before pointing it at a project you care about.
8. **Write down what surprised you** in [docker-agent/gotchas.md](docker-agent/gotchas.md), with the receipt. A pattern a second team copies goes in [docker-agent/patterns.md](docker-agent/patterns.md).

## Experiments

An experiment that is not ready to be a team can live in its own directory under `workflows/` **without** a `workflow.yaml`; the launcher and `validate:teams` ignore it. Add the manifest when it should be launchable. Record what the experiment taught you in `docs/`, whether or not it survives.
