# Claude Code pinned to one version and configured only by what this image holds
# (see README.md). The user's own ~/.claude is never mounted, so their global
# CLAUDE.md, plugins, MCP servers and hooks cannot change how the agents behave.
FROM node:22-bookworm-slim

# Bump deliberately: each Claude Code release changes its system prompt and tools.
ARG CLAUDE_CODE_VERSION=2.1.284

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && npm cache clean --force

# Claude Code's whole configuration lives here. DISABLE_AUTOUPDATER keeps the pinned version.
ENV CLAUDE_CONFIG_DIR=/home/node/.claude \
    DISABLE_AUTOUPDATER=1
COPY --chown=node:node claude-config/ /home/node/.claude/
COPY --chown=node:node team/ /opt/team/

# uid 1000, like most single-user Linux accounts, so files written to a mounted
# worktree belong to the user.
USER node
WORKDIR /work
ENTRYPOINT ["claude"]
