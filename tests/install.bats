#!/usr/bin/env bats
bats_require_minimum_version 1.5.0
# Tests scripts/install.sh against a throwaway HOME. The real home directory and
# dotfiles are never touched: every run sets HOME to a fresh temporary directory.

setup() {
  repository_root=$(cd "$BATS_TEST_DIRNAME/.." && pwd)
  installer="$repository_root/scripts/install.sh"
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME"
  printf '%s\n' '[ -f ~/.bash_aliases ] && . ~/.bash_aliases' >"$HOME/.bashrc"
  printf '%s\n' "alias gs='git status'" >"$HOME/.bash_aliases"
}

count_lines_matching() {
  grep -cxF "$1" "$2" || true
}

@test "creates the symlink to the repository and an alias that resolves through it" {
  run "$installer"
  [ "$status" -eq 0 ]
  [ -L "$HOME/docker-agent-workflows" ]
  [ "$(readlink -f "$HOME/docker-agent-workflows")" = "$repository_root" ]
  grep -qxF "alias daw=$HOME/docker-agent-workflows/bin/daw" "$HOME/.bash_aliases"
  # The user's own aliases survive.
  grep -qxF "alias gs='git status'" "$HOME/.bash_aliases"
}

@test "the installed alias runs the launcher and it finds the teams through the symlink" {
  "$installer"
  # `list` (not --help) so team discovery, which locates the repository from the
  # launcher's own path, is exercised when entered through the home symlink.
  run bash -c 'shopt -s expand_aliases; . "$HOME/.bash_aliases"
daw list'
  [ "$status" -eq 0 ]
  [[ $output == *"issue-team — "* ]]
}

@test "running twice leaves exactly one alias block" {
  "$installer"
  "$installer"
  [ "$(count_lines_matching '# >>> docker-agent-workflows launcher >>>' "$HOME/.bash_aliases")" -eq 1 ]
  [ "$(grep -c '^alias daw=' "$HOME/.bash_aliases")" -eq 1 ]
}

@test "a new alias name replaces the old one instead of adding a second" {
  "$installer"
  "$installer" --alias agents
  grep -q '^alias agents=' "$HOME/.bash_aliases"
  run ! grep -q '^alias daw=' "$HOME/.bash_aliases"
}

@test "refuses to replace a real directory at the link path" {
  mkdir "$HOME/docker-agent-workflows"
  touch "$HOME/docker-agent-workflows/keep-me"
  run "$installer"
  [ "$status" -eq 1 ]
  [[ $output == *"exists and is not a symlink"* ]]
  [ -f "$HOME/docker-agent-workflows/keep-me" ]
}

@test "re-points a stale symlink left from an earlier clone location" {
  ln -s "$BATS_TEST_TMPDIR/old-clone" "$HOME/docker-agent-workflows"
  run "$installer"
  [ "$status" -eq 0 ]
  [ "$(readlink -f "$HOME/docker-agent-workflows")" = "$repository_root" ]
}

@test "--dry-run changes nothing" {
  cp "$HOME/.bash_aliases" "$BATS_TEST_TMPDIR/aliases-before"
  run "$installer" --dry-run
  [ "$status" -eq 0 ]
  [ ! -e "$HOME/docker-agent-workflows" ]
  cmp "$HOME/.bash_aliases" "$BATS_TEST_TMPDIR/aliases-before"
  # The report must not claim changes it did not make.
  [[ $output != *"created symlink"* ]]
  [[ $output != *"written to"* ]]
  [[ $output == *"dry run: nothing changed"* ]]
}

@test "--uninstall --dry-run changes nothing and says so" {
  "$installer"
  cp "$HOME/.bash_aliases" "$BATS_TEST_TMPDIR/aliases-before"
  run "$installer" --uninstall --dry-run
  [ "$status" -eq 0 ]
  [ -L "$HOME/docker-agent-workflows" ]
  cmp "$HOME/.bash_aliases" "$BATS_TEST_TMPDIR/aliases-before"
  [[ $output != *"removed"* ]]
  [[ $output == *"dry run: nothing changed"* ]]
}

@test "--uninstall removes the block and our symlink, keeps the user's aliases" {
  "$installer"
  run "$installer" --uninstall
  [ "$status" -eq 0 ]
  [ ! -e "$HOME/docker-agent-workflows" ]
  run ! grep -q 'docker-agent-workflows' "$HOME/.bash_aliases"
  grep -qxF "alias gs='git status'" "$HOME/.bash_aliases"
}

@test "--uninstall leaves a symlink that points somewhere else" {
  ln -s "$BATS_TEST_TMPDIR/someone-elses" "$HOME/docker-agent-workflows"
  run "$installer" --uninstall
  [ "$status" -eq 0 ]
  [ -L "$HOME/docker-agent-workflows" ]
}

@test "rejects an alias name that is not a shell word" {
  run "$installer" --alias 'daw; rm -rf ~'
  [ "$status" -eq 1 ]
  [[ $output == *"must match"* ]]
}
