# Issue-team entry points. Source from ~/.bashrc, wherever this directory lives:
#   source <path-to-team>/issue-team.sh
# Run inside any git repository whose origin is on GitHub:
#   work-issue <issue>   fresh worktree from the remote default branch → opened PR
#   pr-followup <pr>     worktree on the PR branch → fixes pushed, threads answered
#   closeout <pr>        fresh worktree at the latest default branch → verified, open threads filed as issues, issues closed
# Worktrees live under ~/.cagent/worktrees and are named after the repository,
# so the same issue number in two repositories never collides.

ISSUE_TEAM_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# team.yaml's script tools and the agents call the bin/ helpers by name.
case ":$PATH:" in
  *":$ISSUE_TEAM_DIR/bin:"*) ;;
  *) export PATH="$ISSUE_TEAM_DIR/bin:$PATH" ;;
esac

_issue_team_ready() {
  [[ ${1:-} =~ ^[0-9]+$ ]] || { echo "expected an issue or PR number, got '${1:-}'" >&2; return 2; }
  git rev-parse --show-toplevel >/dev/null || return 1
}

_issue_team_repo() {
  basename "$(git rev-parse --show-toplevel)"
}

work-issue() {
  _issue_team_ready "${1:-}" || return
  local base
  base=$(issue-team-base-ref) || return
  docker agent run "$ISSUE_TEAM_DIR/team.yaml" \
    --worktree="$(_issue_team_repo)-issue-$1" --worktree-base "$base" \
    "Work issue #$1"
}

pr-followup() {
  _issue_team_ready "${1:-}" || return
  local prompt="Follow up on PR #$1: unresolved review threads, review comments, failing checks."
  # docker-agent names PR worktrees pr-<number> without the repository, so a kept
  # one is reused only when it belongs to this repository.
  local wt="$HOME/.cagent/worktrees/pr-$1"
  if [[ -d $wt ]]; then
    if [[ $(git -C "$wt" remote get-url origin) != "$(git remote get-url origin)" ]]; then
      echo "$wt belongs to another repository; remove it with 'git worktree remove' from that repository first" >&2
      return 1
    fi
    docker agent run "$ISSUE_TEAM_DIR/team.yaml" -a followup --working-dir "$wt" "$prompt"
  else
    docker agent run "$ISSUE_TEAM_DIR/team.yaml" -a followup --worktree-pr "$1" "$prompt"
  fi
}

closeout() {
  _issue_team_ready "${1:-}" || return
  local base
  base=$(issue-team-base-ref) || return
  docker agent run "$ISSUE_TEAM_DIR/team.yaml" -a closeout \
    --worktree="$(_issue_team_repo)-closeout-pr-$1" --worktree-base "$base" \
    "PR #$1 is merged. Close it out."
}
