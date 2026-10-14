#!/usr/bin/env bash
# Runs shellcheck over every shell script in the repository: launcher shims,
# installer, team helpers and sourced entry files, and the bats tests.
# Exits non-zero on any finding, including style and info levels.
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repository_root"

# Executables are found by shebang, so a new helper in any team's bin/ is linted
# without editing this list. Sourced files (*.sh) have no shebang to go by.
mapfile -t shell_files < <(
  {
    find . \( -path ./node_modules -o -path ./.git \) -prune -o -type f -name '*.sh' -print
    find . \( -path ./node_modules -o -path ./.git \) -prune -o -type f -perm -u+x -print |
      while read -r candidate; do
        if head -n 1 "$candidate" | grep -qE '^#!.*\b(ba)?sh\b'; then
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
mapfile -t bats_files < <(find . \( -path ./node_modules -o -path ./.git \) -prune -o -type f -name '*.bats' -print | sort)

echo "shellcheck: ${#shell_files[@]} shell files, ${#bats_files[@]} bats files"
shellcheck --severity=style --shell=bash --external-sources "${shell_files[@]}"
if [[ ${#bats_files[@]} -gt 0 ]]; then
  shellcheck --severity=style --external-sources "${bats_files[@]}"
fi
