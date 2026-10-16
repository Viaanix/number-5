# Adding a team or an experiment

A team is a directory under `workflows/`. Use [pr-reviewer](../workflows/pr-reviewer/README.md) as the small native-model reference and [issue-team](../workflows/issue-team/README.md) for a multi-agent one (sub-agents, shell, typed tools, permissions). [test-quality](../workflows/test-quality/README.md) is a native team with four single-agent entry points and a read-only sub-agent. No team uses a Claude Code harness any more.

## Layout

```
workflows/my-team/
  team.yaml           docker-agent config: native models/tools or CLI harnesses, flavors
  workflow.yaml       launcher manifest: entry points, parameters, worktree mode, task messages
  instructions/       optional: durable native-agent prompts loaded by instruction_file; j5-craft.md is a copy of skills/j5-craft/SKILL.md that every native agent lists first
  helpers/            deterministic Bun scripts the agents run by bare name
  bin/                one sh + one .cmd launcher per helper; listed in workflow.yaml `path`
  README.md           what it does, its agents, its limits
```

## Steps

1. **Write `team.yaml`**: choose native model agents with explicit providers and toolsets, or `harness: claude-code` agents. A proxy-backed native agent uses the local proxy bearer secret, not an Anthropic API key; the proxy owns its subscription login. A harness agent does not get native tools or prompt files ([patterns](docker-agent/patterns.md)). Check parsing with `docker agent debug config workflows/my-team/team.yaml`.
2. **Separate procedure from task parameters.** Native agents can put their durable procedure in an `instruction_file`, leaving `workflow.yaml`'s `message` to identify the task. A Claude Code harness agent must receive its whole procedure, output format and rules through that message. `{param}` fills a manifest parameter; write `{{` and `}}` for literal braces. **Every native agent lists `instructions/j5-craft.md` first**, a copy of [`skills/j5-craft/SKILL.md`](../skills/j5-craft/SKILL.md) (`cp skills/j5-craft/SKILL.md workflows/my-team/instructions/j5-craft.md`): it is the rule that a claim needs a receipt and a citation is copied from tool output. `launcher/test/craft-skill.test.ts` fails when an agent lacks it or a copy drifts. It has to be in the prompt, not read by path: a model skips a file it is told to read first ([patterns](docker-agent/patterns.md#load-required-context-into-the-prompt-dont-ask-the-agent-to-fetch-it)).
3. **Move anything deterministic into a helper** that the prompt tells the agent to run by bare name (the helper reads its arguments from the command line or the environment). Write it as `helpers/<verb>.ts`, using `runHelper` and `readToolArgument` from `launcher/src/team-helper.ts` (import it as `#launcher/team-helper.ts`); logic another team already has (the change diff, the test pre-screen) is a function in `launcher/src/` to call, not code to copy. Copy a launcher pair from `workflows/issue-team/bin/` as `bin/<team>-<verb>` and `bin/<team>-<verb>.cmd`. The `<team>-` prefix keeps two teams' helpers from shadowing each other on `PATH`. Never name a tool argument `path`: arguments reach the helper as environment variables, and on Windows `path` is `PATH`. See [patterns](docker-agent/patterns.md#helpers-that-run-on-every-os).
   Native agents expose helpers as typed `type: script` tools; a harness prompt instead names a command for its external CLI's shell. Do not add a general shell when bounded script and read-only filesystem tools suffice.
4. **Offer model and effort choices** by adding a `flavors:` block to `workflow.yaml` listing the named models (keys under `models:` in `team.yaml`) that `--model` and `--effort` change, and two marker lines at the end of `team.yaml`: `# BEGIN GENERATED FLAVORS` and `# END GENERATED FLAVORS`. Then run `bun run flavors`: it writes the standard flavors (`model-<tier>`, `effort-<level>`, and `reviewer-on-<tier>` when the team has an `independence` rule) between the markers from `workflows/flavors.yaml`. Do not write flavors by hand; `validate:teams` rejects a stale block and any flavor name no option can reach.
5. **Write `workflow.yaml`** ([schema](launcher.md#the-manifest-workflowsteamworkflowyaml)) with one entry point per way of starting the team.
   To let an entry point also run unattended over a list, add a `queue:` block to it ([schema](launcher.md#the-manifest-workflowsteamworkflowyaml)). Its `preamble` must say nobody will answer and end by asking for the `RESULT:` line the queue reads: `RESULT: PR <url>` for a team that opens a pull request, `RESULT: DONE <what was done>` for one that does not, `RESULT: FAILED <reason>`. The outcome comes from that line, never the exit code. Set `items: pull-requests` when the numbers are PRs. A tool that `team.yaml` leaves unapproved so a person confirms it, but that the unattended run must call, goes in `approves`: `--exec` rejects a tool nobody can approve, and `bun run flavors` writes the `queue-unattended` flavor that approves it for queued runs only (this needs the `flavors:` block).
   A team that writes to GitHub should enforce its limits in a helper, not in the prompt: what it reads is written by other people. The [triage team](../workflows/triage/README.md) is the example (a fixed label set, one comment, a bounded split, a dry-run switch).
6. **Check it:**
   ```bash
   bun run validate:teams                       # manifest rules, agents exist, configs parse, generated flavors current and correct, dry runs
   j5 list                                     # it shows up
   j5 my-team <entrypoint> --<param> … --print # the command is what you expect
   j5 my-team <entrypoint> --<param> … -- --dry-run --exec   # docker-agent initializes it for real
   ```
   Native providers still require a non-empty credential during dry-run initialization. CI sets `PI_PROXY_AUTH_TOKEN=validation-only-no-model-calls` for the proxy provider; this placeholder is never used for real inference.
7. **Run it for real** on a throwaway repository before pointing it at a project you care about.
8. **Write down what surprised you** in [docker-agent/gotchas.md](docker-agent/gotchas.md), with the receipt. A pattern a second team copies goes in [docker-agent/patterns.md](docker-agent/patterns.md).

## Experiments

An experiment that is not ready to be a team can live in its own directory under `workflows/` **without** a `workflow.yaml`; the launcher and `validate:teams` ignore it. Add the manifest when it should be launchable. Record what the experiment taught you in `docs/`, whether or not it survives.
