#!/usr/bin/env bash
# Installs the `daw` launcher for the current user:
#   1. a symlink to this repository in the home directory (default ~/docker-agent-workflows),
#      so the alias keeps working wherever the repository is cloned or moved — re-run
#      this script after a move to re-point the link;
#   2. an alias in ~/.bash_aliases (Debian/Ubuntu ~/.bashrc sources that file), inside
#      marker lines so re-running replaces it instead of adding a second copy;
#   3. the launcher's bun dependencies, when node_modules is missing.
#
# Usage: scripts/install.sh [--link PATH] [--alias NAME] [--aliases-file FILE] [--dry-run]
#        scripts/install.sh --uninstall [--link PATH] [--aliases-file FILE] [--dry-run]
set -euo pipefail

readonly BLOCK_BEGIN_MARKER="# >>> docker-agent-workflows launcher >>>"
readonly BLOCK_END_MARKER="# <<< docker-agent-workflows launcher <<<"
readonly ALIAS_NAME_PATTERN='^[A-Za-z_][A-Za-z0-9_-]*$'

repository_root=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)
link_path="$HOME/docker-agent-workflows"
alias_name="daw"
aliases_file="$HOME/.bash_aliases"
dry_run=false
uninstall=false

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

fail() {
  echo "install: $*" >&2
  exit 1
}

# Prints what would happen in --dry-run mode; otherwise runs the command.
run() {
  if [[ $dry_run == true ]]; then
    printf 'would run:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --link) link_path=${2:?--link needs a path}; shift 2 ;;
    --alias) alias_name=${2:?--alias needs a name}; shift 2 ;;
    --aliases-file) aliases_file=${2:?--aliases-file needs a path}; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    --uninstall) uninstall=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) fail "unknown argument '$1' (see --help)" ;;
  esac
done

[[ $alias_name =~ $ALIAS_NAME_PATTERN ]] || fail "alias name '$alias_name' must match $ALIAS_NAME_PATTERN"

# Reports a change that was just made. Silent in --dry-run mode, where the
# "would run" / "would write" lines already describe the plan and nothing changed.
report() {
  if [[ $dry_run != true ]]; then
    echo "$@"
  fi
}

# Ends the run with the right closing line for the mode.
finish() {
  if [[ $dry_run == true ]]; then
    echo "dry run: nothing changed"
  else
    echo "$@"
  fi
  exit 0
}

# Prints the aliases file without the launcher block (and without the block's markers).
aliases_without_block() {
  if [[ -f $aliases_file ]]; then
    awk -v begin="$BLOCK_BEGIN_MARKER" -v end="$BLOCK_END_MARKER" '
      $0 == begin { inside = 1; next }
      $0 == end { inside = 0; next }
      !inside { print }
    ' "$aliases_file"
  fi
}

# Replaces the aliases file's content with stdin, keeping the file's permissions.
rewrite_aliases_file() {
  local new_content
  new_content=$(cat)
  if [[ $dry_run == true ]]; then
    echo "would write $aliases_file:"
    printf '%s\n' "$new_content" | sed 's/^/  | /'
  else
    printf '%s\n' "$new_content" >"$aliases_file"
  fi
}

# True when link_path is a symlink that resolves to this repository.
link_points_here() {
  [[ -L $link_path && $(readlink -f "$link_path") == "$repository_root" ]]
}

if [[ $uninstall == true ]]; then
  if [[ -f $aliases_file ]] && grep -qxF "$BLOCK_BEGIN_MARKER" "$aliases_file"; then
    aliases_without_block | rewrite_aliases_file
    report "removed the launcher alias block from $aliases_file"
  else
    echo "no launcher alias block in $aliases_file"
  fi
  if link_points_here; then
    run rm "$link_path"
    report "removed symlink $link_path"
  elif [[ -e $link_path || -L $link_path ]]; then
    echo "left $link_path alone: it is not a symlink to $repository_root"
  fi
  finish "uninstalled; open a new shell so the alias is gone"
fi

# 1. Symlink. Refuse to replace anything that is not already a symlink of ours or a
#    stale symlink, so a real directory at that path is never touched.
if link_points_here; then
  echo "symlink $link_path → $repository_root already in place"
elif [[ -L $link_path ]]; then
  previous_target=$(readlink "$link_path")
  run ln -sfn "$repository_root" "$link_path"
  report "re-pointed symlink $link_path → $repository_root (was $previous_target)"
elif [[ -e $link_path ]]; then
  fail "$link_path exists and is not a symlink; pass --link <other path>"
else
  run ln -s "$repository_root" "$link_path"
  report "created symlink $link_path → $repository_root"
fi

# 2. Alias block, replacing any earlier one.
{
  aliases_without_block
  echo "$BLOCK_BEGIN_MARKER"
  printf 'alias %s=%q\n' "$alias_name" "$link_path/bin/daw"
  echo "$BLOCK_END_MARKER"
} | rewrite_aliases_file
report "alias $alias_name written to $aliases_file"

if [[ $aliases_file == "$HOME/.bash_aliases" ]] && ! grep -qs 'bash_aliases' "$HOME/.bashrc"; then
  echo "warning: ~/.bashrc does not mention .bash_aliases; add: [ -f ~/.bash_aliases ] && . ~/.bash_aliases" >&2
fi

# 3. Dependencies.
if [[ -d $repository_root/node_modules ]]; then
  echo "dependencies already installed"
else
  command -v bun >/dev/null || fail "bun is not installed (https://bun.sh)"
  run bun install --cwd "$repository_root" --frozen-lockfile
fi

finish "done; open a new shell or run: source $aliases_file"
