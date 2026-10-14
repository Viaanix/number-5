#!/usr/bin/env bash
# Runs shellcheck over every shell script in the repository: launcher shims,
# installer, team helpers and sourced entry files, and the bats tests.
# Exits non-zero on any finding, including style and info levels.
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repository_root"

# Written for bash 3.2, which macOS ships as /bin/bash: no mapfile, and only POSIX
# character classes in grep patterns (BSD grep has no GNU \b).

# A shebang naming sh or bash, e.g. `#!/bin/sh` or `#!/usr/bin/env bash` (not bats).
readonly SHELL_SHEBANG_PATTERN='^#!.*[/ ](ba)?sh([[:space:]]|$)'

list_files() {
  find . \( -path ./node_modules -o -path ./.git \) -prune -o -type f "$@" -print
}

# Executables are found by shebang, so a new helper in any team's bin/ is linted
# without editing this list. Sourced files (*.sh) have no shebang to go by.
shell_files=()
while IFS= read -r shell_file; do
  shell_files+=("$shell_file")
done < <(
  {
    list_files -name '*.sh'
    list_files -perm -u+x | while IFS= read -r candidate; do
      if head -n 1 "$candidate" | grep -qE "$SHELL_SHEBANG_PATTERN"; then
        echo "$candidate"
      fi
    done
  } | sort -u
)

if [[ ${#shell_files[@]} -eq 0 ]]; then
  echo "lint-shell: no shell files found" >&2
  exit 1
fi

# bats files are linted separately: shellcheck recognizes their `@test` syntax only
# from the bats shebang, which --shell=bash (needed for the sourced *.sh files) overrides.
bats_files=()
while IFS= read -r bats_file; do
  bats_files+=("$bats_file")
done < <(list_files -name '*.bats' | sort)

echo "shellcheck: ${#shell_files[@]} shell files, ${#bats_files[@]} bats files"
shellcheck --severity=style --shell=bash --external-sources "${shell_files[@]}"
if [[ ${#bats_files[@]} -gt 0 ]]; then
  shellcheck --severity=style --external-sources "${bats_files[@]}"
fi
