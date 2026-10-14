A pull request has merged. You run in a fresh worktree at the latest remote default branch. Close out the issues it addressed, with evidence, and leave no review thread on it open without an issue tracking it.

## Procedure

1. **Confirm the merge.** `gh pr view <N> --json state,mergedAt,mergeCommit,baseRefName,headRefName,closingIssuesReferences,title,body,url`. If the state is not MERGED, stop. If the base is not the default branch, note that GitHub does not auto-close issues for it.
2. **Find the linked issues**: closingIssuesReferences plus issues referenced in the body (`#123`, `owner/repo#123`). For each, `gh issue view <i> --json state,title,body,comments`.
3. **Find the open review threads**: call pr_threads for the PR. Every thread it returns is open, outdated or not. For each, check whether an issue already tracks it: `gh issue list --state all --search "<thread id> in:body" --json number,state,title`. A thread with a tracking issue needs nothing more; every other thread gets a follow-up issue in step 7.
4. **Verify the default branch.** `git merge-base --is-ancestor <merge commit> HEAD` must succeed. Learn the project's commands from AGENTS.md / CLAUDE.md, manifests and .github/workflows, then run install, build, typecheck/lint and the full test suite. Record the HEAD SHA, each command, and its pass/fail counts. If anything fails, stop and report; never close issues on a red default branch.
5. **Judge each linked issue** against the merged change (`gh pr diff <N>`): **done**, **partial**, or **not addressed**, per acceptance criterion and checkbox.
6. **Show the plan** to the user and wait for the go-ahead:
   - per linked issue: verdict, the boxes to tick, and the comment text;
   - per open thread: either the issue that already tracks it, or the title and body of the follow-up issue you will create.
7. **Execute**, writing every body and comment with write_file to a file under /tmp.
   First, **file the follow-up issues**, one per untracked open thread, with `gh issue create --title "<title>" --body-file <file>`:
   - title: what is unresolved, in the reviewer's terms, not "Review thread on PR #N";
   - body: `Review thread: <thread id>` on its own line (step 3 finds it on a rerun, so no thread is filed twice); the PR URL; the first comment's URL; `path:line` at merge (or "outdated" if the code moved); each comment quoted with its author; and one sentence on what remains to decide or do.
   Then the linked issues:
   - **done** — tick only the boxes the PR met (`gh issue edit <i> --body-file <file>`), comment the evidence (`gh issue comment <i> --body-file <file>`: the PR, what changed, the verification line from step 4, and the follow-up issues filed for open threads), and close with `gh issue close <i> --reason completed` if still open. If GitHub already closed it, still add the evidence comment unless an equivalent one exists.
   - **partial** — tick the met boxes, comment what remains and the follow-up issues, leave it open.
   - **not addressed** — comment nothing; report it to the user.
8. **Confirm** by calling pr_threads again and checking every thread it returns against an issue: each must be tracked. Report the thread → issue mapping.
9. **Clean up.** List `git worktree list` entries and local branches for this PR's head branch and for this issue's workflow (`worktree-*-issue-<i>`). Remove them only after the user agrees. Never delete remote branches or branches this workflow did not create.

Report only results you observed from commands you ran.
