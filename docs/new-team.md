# Adding a team or an experiment

A team is a directory under `workflows/`. Use [pr-reviewer](../workflows/pr-reviewer/README.md) as the native-model reference, or copy `workflows/issue-team/` for a Claude Code harness team.

## Layout

```
workflows/my-team/
  team.yaml           docker-agent config: native models/tools or CLI harnesses, flavors
  workflow.yaml       launcher manifest: entry points, parameters, worktree mode, task messages
  instructions/       optional: durable native-agent prompts loaded by instruction_file
  roles/              optional: sub-agent role prompts shared by several entry points, printed by a <team>-role helper
  helpers/            deterministic Bun scripts the agents run by bare name
  bin/                one sh + one .cmd launcher per helper; listed in workflow.yaml `path`
  README.md           what it does, its agents, its limits
```

## Steps

1. **Write `team.yaml`**: choose native model agents with explicit providers and toolsets, or `harness: claude-code` agents. A proxy-backed native agent uses the local proxy bearer secret, not an Anthropic API key; the proxy owns its subscription login. A harness agent does not get native tools or prompt files ([patterns](docker-agent/patterns.md)). Check parsing with `docker agent debug config workflows/my-team/team.yaml`.
2. **Separate procedure from task parameters.** Native agents can put their durable procedure in an `instruction_file`, leaving `workflow.yaml`'s `message` to identify the task. A Claude Code harness agent must receive its whole procedure, output format and rules through that message. `{param}` fills a manifest parameter; write `{{` and `}}` for literal braces.
3. **Move anything deterministic into a helper** that the prompt tells the agent to run by bare name (the helper reads its arguments from the command line or the environment). Write it as `helpers/<verb>.ts`, using `runHelper` and `readToolArgument` from `launcher/src/team-helper.ts`; logic another team already has (the change diff, the test pre-screen) is a function in `launcher/src/` to call, not code to copy. Copy a launcher pair from `workflows/issue-team/bin/` as `bin/<team>-<verb>` and `bin/<team>-<verb>.cmd`. The `<team>-` prefix keeps two teams' helpers from shadowing each other on `PATH`. Never name a tool argument `path`: arguments reach the helper as environment variables, and on Windows `path` is `PATH`. See [patterns](docker-agent/patterns.md#helpers-that-run-on-every-os).
   Native agents expose helpers as typed `type: script` tools; a harness prompt instead names a command for its external CLI's shell. Do not add a general shell when bounded script and read-only filesystem tools suffice.
4. **Define flavors** if the team needs model or effort choices: native flavors patch `models:`, while harness flavors patch `harness.effort` or `harness.model`. Keep each flavor to the keys it changes.
5. **Write `workflow.yaml`** ([schema](launcher.md#the-manifest-workflowsteamworkflowyaml)) with one entry point per way of starting the team.
6. **Check it:**
   ```bash
   bun run validate:teams                       # manifest rules, agents exist, configs parse, flavors change something, dry runs
   j5 list                                     # it shows up
   j5 my-team <entrypoint> --<param> … --print # the command is what you expect
   j5 my-team <entrypoint> --<param> … -- --dry-run --exec   # docker-agent initializes it for real
   ```
   Native providers still require a non-empty credential during dry-run initialization. CI sets `PI_PROXY_AUTH_TOKEN=validation-only-no-model-calls` for the proxy provider; this placeholder is never used for real inference.
7. **Run it for real** on a throwaway repository before pointing it at a project you care about.
8. **Write down what surprised you** in [docker-agent/gotchas.md](docker-agent/gotchas.md), with the receipt. A pattern a second team copies goes in [docker-agent/patterns.md](docker-agent/patterns.md).

## Experiments

An experiment that is not ready to be a team can live in its own directory under `workflows/` **without** a `workflow.yaml`; the launcher and `validate:teams` ignore it. Add the manifest when it should be launchable. Record what the experiment taught you in `docs/`, whether or not it survives.
