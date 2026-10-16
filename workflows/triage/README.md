# Triage team

Looks at one GitHub issue and decides whether it can be worked on as written. It records the decision on the issue: it asks for what is missing, flags a decision a person has to make, splits an issue that is too large into sub-issues, or marks it ready. The agent is a native docker-agent agent on the local Pi proxy, built like [pr-reviewer](../pr-reviewer/README.md).

```bash
cd ~/code/some-repo
j5 triage triage --issue 123                       # read-only checkout; records the verdict on GitHub
J5_TRIAGE_DRY_RUN=1 j5 triage triage --issue 123   # same, but writes nothing and prints what it would do
j5 triage triage --queue 120,123,131               # each issue in turn, unattended
j5 triage triage --queue-label bug --model opus    # every open issue labeled bug, on Opus
j5 triage triage --issue 123 --print               # show the docker agent command only
```

**It runs in the checkout itself and only reads it.** There is no worktree and the agent has no shell and no write tool for files, so it cannot change your code. It reads the issue and the code the issue concerns, then makes one decision. Start with `J5_TRIAGE_DRY_RUN=1` until you trust the verdicts.

## Prerequisite: the Pi proxy

Every model call goes to `http://127.0.0.1:4141/v1` (`containers/pi-openai-proxy`), which must be running, with `PI_PROXY_AUTH_TOKEN` exported or saved in `~/.config/cagent/.env`. The `gh` CLI must be logged in to an account that can see the repository and edit its issues and labels.

## The four verdicts

When more than one fits, the first that applies wins: needs-info, then needs-decision, then split, then ready. You cannot split work nobody understands, and you cannot ask for work that still needs a decision.

| Verdict | Label | Means | What the agent writes |
|---|---|---|---|
| needs-info | `j5/needs-info` | Facts are missing that only the reporter can supply | At most five numbered questions, and what it already checked in the code |
| needs-decision | `j5/needs-decision` | The information is there, but a person has to choose (also: a duplicate or already-fixed issue) | The decision in one sentence, two to four options with their costs, a recommendation |
| split | `j5/split` | Actionable, but too large for one pull request | A comment explaining the order, and 2 to 8 sub-issues, each small enough for one PR |
| ready | `j5/ready` | Someone could start now, and it fits one pull request | What it understood, where in the code (cited), traps, how to verify |

`j5/ready` is the label a later step can act on: it is what you would hand to [issue-team](../issue-team/README.md). Sub-issues created by a split get their parent's own labels (type, area) plus `j5/ready`, and no other `j5/` label.

## What `triage_apply` may do, fixed in code

The issue text is written by other people, so what the agent can do to GitHub does not depend on it staying on task. `helpers/triage-plan.ts` and `helpers/apply.ts` enforce all of this, and a refusal writes nothing:

- Four labels only, all under `j5/`. It adds the verdict's label and removes any other verdict label. It never touches another label, and creates the four if the repository lacks them.
- One comment per call, up to 20,000 characters, refused if it contains a credential shape (the same check `pr-reviewer` uses). The comment carries a hidden marker and a footer saying nothing was built or run.
- A split makes 2 to 8 sub-issues (titles unique, bodies up to 3,000 characters) and links them with GitHub's sub-issue API. It refuses to split an issue that already has sub-issues.
- Open issues only: it refuses pull requests (`gh issue view` also answers for a pull request's number), closed issues and archived repositories.
- Run again with the same verdict and nobody has commented since: it skips. After someone replies, it posts again.
- It cannot edit code, close or reopen an issue, assign anyone, or write to any other repository: the repository is the one the checkout belongs to.

`triage_context` shows the agent the issue inside `UNTRUSTED` markers. A marker written by a reporter is removed first, so an issue body cannot close the fence and put instructions outside it.

## Queue runs

`--queue` and `--queue-label` run the team once per issue, with `--exec`: nobody answers. Each item ends with `RESULT: DONE <verdict> #<issue>: <summary>` or `RESULT: FAILED <reason>`. A `DONE` counts as a success in the queue summary and exit code, though no pull request is opened (the shared queue code reads `RESULT: DONE`; issue-team's summary is unchanged). `--max-rounds` has no effect here.

## Models and instructions

The default is `claude-sonnet-5-5` at effort `high`. `--model haiku|sonnet|opus|fable` and `--effort low|medium|high|xhigh` work as in the other teams (the flavors are generated into `team.yaml`: `bun run flavors`). The procedure is `instructions/triager.md`, with `instructions/j5-craft.md` (a copy of the shared [j5-craft](../../skills/j5-craft/SKILL.md) skill) first, as for every agent. There is no independent reviewer: nothing here is code, and a human reads the verdict.

## Known limits

- **Judgment is lightly tested.** The unit tests cover the guardrails against a fake GitHub and a real git repository. The model itself was run on three issues (below), which is too few to say whether its verdicts are good. Run it with `J5_TRIAGE_DRY_RUN=1` first.
- **The agent cannot run the code.** It reads it, so it cannot confirm that a bug reproduces. It is told to say so.
- **Who filed the issue is not checked.** `triage_context` shows the author's association, but nothing refuses an outsider's issue. The blast radius is small (labels, comments and issues in one repository, within the limits above), but on a public repository that is still text a stranger can cause to be posted.
- **One comment can say a wrong thing.** The comment is the model's, and the credential check is best effort. Nothing posted can be edited or deleted by this team.
- **A failure partway through a split** leaves the children it already created. The error names them, the parent is not labeled and not commented on, and a re-run refuses to split again until a person has looked.
- **Sub-issue creation** uses `POST /repos/{owner}/{repo}/issues/{n}/sub_issues` with `sub_issue_id`, the child's numeric id, as GitHub's documentation gives it. A failure there stops the split as described above.

## Verified, 2026-10-16

Real GitHub (this repository) and a real model through the proxy, on Sonnet 5.5. The test issues were deleted afterwards, and so were the four `j5/` labels, which the repository did not have before.

- **Dry run:** `J5_TRIAGE_DRY_RUN=1 j5 triage triage --issue 30` took 40 seconds. The variable reached `triage_apply` through docker-agent ("DRY RUN … nothing was written"), issue 30 was left untouched, and the verdict was `needs-decision`, with call sites and test lines that match the checkout (one citation was two lines off: a comment line rather than the test below it).
- **Queue:** `j5 triage triage --queue 36,37` (a vague bug and a design question) took 77 seconds: `needs-info` with five numbered questions, and `needs-decision` with four options and a recommendation. Each got its `j5/` label (created with the colors and descriptions above) and one comment, and the summary read "2 of 2 finished (0 opened a pull request, 2 completed without one)" with exit code 0.
- **Real API, called directly (no model):** the same verdict again was skipped; a split created two sub-issues that GitHub reports as linked (parent total 2, each child shows its parent), labeled with the parent's labels plus `j5/ready`, with the parent labeled `j5/split` and one comment; a second split and a pull request's number were both refused; a real non-null `parent` and real sub-issue nodes parse.

**Not verified:** the model choosing `split` or `ready` on its own (its verdicts were `needs-decision`, `needs-info`, `needs-decision`; the split above was a fixed call to the helper), `--queue-label`, a public repository, the Windows launchers against the real `gh` (CI uses a fake one), and any model other than Sonnet 5.5.
