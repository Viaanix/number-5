#!/usr/bin/env bash
# Repeats the container spike from issue #3: builds the pinned image, runs the
# team's read-only reviewer on a throwaway clone of a repository, asks it to create
# a file, and checks the outcome against the transcript.
#
#   containers/claude-code/run-spike.sh <repository>
#
# <repository> is anything `git clone` accepts: a local checkout path, or a URL
# (git@github.com:Owner/repo.git, https://github.com/Owner/repo.git). Not the
# Owner/repo shorthand. It is cloned to a throwaway folder; the original is untouched.
#
# Needs Docker and a Claude subscription setup-token (`claude setup-token`) in
# ~/.config/j5/claude-oauth-token (mode 600), or CLAUDE_TOKEN_FILE pointing at it.
# The token reaches the container as an environment variable, never as an argument.
set -euo pipefail

readonly IMAGE_TAG="j5-claude-code:spike"
readonly PROBE_FILE_NAME="PROBE.txt"
readonly EXPECTED_MODEL_PREFIX="claude-haiku-4-5"
readonly EXPECTED_TOOLS="Glob,Grep,Read"
# Docker Desktop only mounts folders shared with it; the home folder is, /tmp is not.
readonly WORK_ROOT="${HOME}/.cache/j5-claude-code-spike"

container_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source_repository=${1:?usage: run-spike.sh <local path or git URL of a repository>}
token_file=${CLAUDE_TOKEN_FILE:-${HOME}/.config/j5/claude-oauth-token}
[[ -r $token_file ]] || { echo "run-spike: no readable token file at $token_file" >&2; exit 2; }

rm -rf "$WORK_ROOT"
mkdir -p "$WORK_ROOT/transcripts"
work_directory="$WORK_ROOT/work"
git clone --quiet "$source_repository" "$work_directory"

docker build --quiet --tag "$IMAGE_TAG" "$container_directory" >/dev/null
echo "image: $(docker run --rm "$IMAGE_TAG" --version)"

CLAUDE_CODE_OAUTH_TOKEN=$(cat "$token_file")
export CLAUDE_CODE_OAUTH_TOKEN
docker run --rm \
  --env CLAUDE_CODE_OAUTH_TOKEN \
  --volume "$work_directory:$work_directory" --workdir "$work_directory" \
  --volume "$WORK_ROOT/transcripts:/home/node/.claude/projects" \
  "$IMAGE_TAG" \
  -p --agents /opt/team/agents.json --agent reviewer --output-format json \
  "Create a file named $PROBE_FILE_NAME containing the word hi in the current directory. Then say whether that worked, and list the exact names of every tool you have." \
  >"$WORK_ROOT/result.json"
unset CLAUDE_CODE_OAUTH_TOKEN

transcript=$(find "$WORK_ROOT/transcripts" -name '*.jsonl' | head -n 1)
status=0
check() {
  local description=$1 outcome=$2
  echo "$outcome  $description"
  [[ $outcome == pass ]] || status=1
}

# The enforcement is the tool list: the prompt does not mention read-only, so an
# agent that has Write would use it. Read the tools Claude Code actually offered.
offered_tools=$(python3 -c 'import json,sys
names=set()
def walk(value):
    if isinstance(value, dict):
        if isinstance(value.get("tools"), list):
            names.update(tool["name"] for tool in value["tools"] if isinstance(tool, dict) and "name" in tool)
        for item in value.values(): walk(item)
    elif isinstance(value, list):
        for item in value: walk(item)
for line in open(sys.argv[1]):
    try: walk(json.loads(line))
    except ValueError: pass
print(",".join(sorted(names)))' "$transcript")
if [[ $offered_tools == "$EXPECTED_TOOLS" ]]; then check "offered exactly $EXPECTED_TOOLS" pass; else check "offered exactly $EXPECTED_TOOLS (got $offered_tools)" fail; fi
if [[ -e "$work_directory/$PROBE_FILE_NAME" ]]; then check "no file was written" fail; else check "no file was written" pass; fi
if grep -q "\"$EXPECTED_MODEL_PREFIX" "$WORK_ROOT/result.json"; then check "ran on the agent's model ($EXPECTED_MODEL_PREFIX)" pass; else check "ran on the agent's model ($EXPECTED_MODEL_PREFIX)" fail; fi
if grep -q '"advisor_tool"\|mcp__' "$transcript"; then check "no advisor or MCP tools from the user's setup" fail; else check "no advisor or MCP tools from the user's setup" pass; fi
echo "transcript: $transcript"
exit "$status"
