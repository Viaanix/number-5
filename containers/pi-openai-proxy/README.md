# Pi OpenAI proxy container

A standalone OpenAI Chat Completions endpoint for Docker Agent Path C, using
[`@victor-software-house/pi-openai-proxy`](https://www.npmjs.com/package/@victor-software-house/pi-openai-proxy).
Docker Agent owns the agent loop and tool execution; Pi supplies model access and
credential handling. This does not change the existing Claude Code harness workflows.

## Pinned components

- Bun 1.4.2, with the base image pinned by multi-platform digest.
- pi-openai-proxy 4.9.5.
- Pi CLI 0.73.0 for subscription login.
- Every resolved dependency is recorded in `bun.lock`; builds use a frozen lockfile
  and do not run dependency lifecycle scripts. Pi's model adapter resolves to 0.73.1.

The build context permits only `package.json` and `bun.lock`. Credentials and the
host's Pi configuration/extensions are not copied into the image or bind-mounted.
Compose mounts this repository's `models.json` read-only, separately from the
named login volume.

## Current models

The pinned Pi release predates the current Claude catalogue. The versioned
`models.json` adds `claude-sonnet-5-5` and `claude-haiku-5-5` through Pi's supported
custom-model configuration, retaining the existing subscription login. Its
context/output limits come from the official [Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)
and [Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview) pages.
Catalogue metadata is not a guarantee of account access or complete feature parity.

Current models need explicit adaptive reasoning through this pinned adapter.
Docker Agent does not map `thinking_budget` to `reasoning_effort` for a Claude
model using its OpenAI client. Set `provider_opts.extra_body.reasoning_effort`
instead; pr-reviewer sets `high` for Sonnet and `medium` for its Haiku flavor.
Without explicit effort, the adapter sends `thinking: disabled`, which Sonnet 5.5
rejects. See the live receipt below.

## Build and log in

From the repository root:

```bash
cd containers/pi-openai-proxy
export PI_PROXY_AUTH_TOKEN="$(openssl rand -hex 32)"
docker compose build

docker compose run --rm --no-deps --entrypoint bun proxy \
  /app/node_modules/@mariozechner/pi-coding-agent/dist/cli.js \
  --no-session --no-tools --no-extensions --offline
```

`PI_PROXY_AUTH_TOKEN` is a local bearer secret protecting the proxy, **not an
Anthropic API key**. Keep it outside the repository. Compose and Docker Agent
must use the same value; generating a replacement while the proxy is running
does not change the proxy's token. Compose refuses to start without a non-empty
value.

To avoid exporting the token in every Docker Agent terminal, save the existing
value in `~/.config/cagent/.env`, which Docker Agent loads automatically.
**Run this once, only if that file has no `PI_PROXY_AUTH_TOKEN` entry yet:**

```bash
mkdir -p "$HOME/.config/cagent"
touch "$HOME/.config/cagent/.env"
chmod 600 "$HOME/.config/cagent/.env"
printf '\nPI_PROXY_AUTH_TOKEN=%s\n' "${PI_PROXY_AUTH_TOKEN:?Use the existing proxy bearer token}" >> "$HOME/.config/cagent/.env"
```

This preserves other entries. If the token already has an entry, reuse it rather
than appending another one or generating a new value. Do not put this file in
the repository. A missing local bearer token does not require another Claude login.

Inside Pi, enter `/login`, select **Use a subscription**, then **Anthropic (Claude
Pro/Max)**. Open the displayed authorization URL in your host browser. The login
container does not publish an OAuth callback port; if the browser redirects to an
unreachable localhost URL, paste the complete redirect URL into Pi's manual input.
Exit Pi when login completes. Do not paste credentials into chat or commit them.

`--offline` disables Pi's startup downloads, not the interactive login request.
Warnings about missing `fd` and `ripgrep` are expected: this image uses Pi for
login, not coding tools. The proxy does not execute Pi tools.

Pi stores its login in the Compose-managed `pi-auth` volume, mounted at
`/home/bun/.pi/agent`. The directory is writable so token refreshes and lockfiles
can persist. The host's `~/.pi/agent` is never mounted. Stop a running proxy before
using this login command again.

## Start and inspect

In the same directory and with the local bearer secret exported:

```bash
docker compose up --wait
curl --fail --silent --show-error http://127.0.0.1:4141/v1/models \
  --header "Authorization: Bearer $PI_PROXY_AUTH_TOKEN"
docker compose logs proxy
```

Compose does not automatically read Docker Agent's env file. In a new terminal,
you can start the service using the saved value without exporting it:

```bash
docker compose --env-file "$HOME/.config/cagent/.env" up --wait
```

Only host loopback is published. To change the host port, export `PI_PROXY_PORT`
before starting Compose; the container always listens on port 4141. The service
runs as UID 1000, with a read-only root filesystem, `/tmp` in memory, all Linux
capabilities dropped, and privilege escalation disabled. No repository or Docker
socket is mounted.

The healthcheck makes an authenticated model-list request. **Healthy does not
prove Claude authentication or inference works.** Without configured credentials,
`/v1/models` returns an empty list. Use an actual returned model ID rather than
assuming a particular Claude release is available through this pinned Pi version.

`docker compose down` removes the service but preserves the login volume. Adding
`--volumes` deletes the stored login. Docker administrators can read the volume
and container environment; this is local isolation, not a secret vault.

## Connect Docker Agent

Merge this provider into your existing `~/.config/cagent/config.yaml`:

```yaml
providers:
  pi:
    base_url: http://127.0.0.1:4141/v1
    api_type: openai_chatcompletions
    token_key: PI_PROXY_AUTH_TOKEN
    provider_opts:
      extra_body:
        reasoning_effort: high
```

With the same local bearer secret exported or saved in Docker Agent's env file:

```bash
docker agent models --provider pi
```

Native agents reference models as `pi/<model ID returned by the proxy>` and must
not retain a `harness:` block. [pr-reviewer](../../workflows/pr-reviewer/README.md)
defines this provider itself, so it needs no global configuration. issue-team and
test-quality remain harness-backed. If Docker Agent itself runs in another
container, `127.0.0.1` refers to that container, not this proxy; this Compose
configuration is for Docker Agent running on the host.

The upstream adapter has a restricted tool-schema subset, omits Anthropic
`response_format`, and does not forward thinking events into its SSE output.
A model listing alone does not establish compatibility with a team's tools.

## Verification receipt

2026-10-15, linux/amd64, Docker Engine 29.8.2, Docker Agent 1.145.0:

- `docker build --tag j5-pi-openai-proxy:4.9.5 containers/pi-openai-proxy` completed.
- `docker compose up --wait` reached healthy with an empty credential volume.
- HTTP smoke: missing/wrong bearer token → 401; authenticated `/v1/models` → 200
  with an empty list; unknown completion model → 404; unsupported `logprobs` → 422.
- Runtime smoke: UID 1000; writes under `/app` failed with `EROFS`; writes under
  the auth directory succeeded and survived `up --force-recreate`.
- The containerized Pi CLI reported 0.73.0; its interactive `/login` selector
  offered subscription authentication and Anthropic (Claude Pro/Max).
- Docker Agent's `models --provider pi`, configured against the container, exited
  0 and reported no models for the empty credential volume.

These initial checks used an isolated Compose project with no provider credentials.

### Authenticated native agent loop

Later on 2026-10-15, after subscription login, the normal Compose service reached
healthy and `docker agent models --provider pi` listed Claude models. A temporary
native team used `pi/claude-haiku-4-5` for both root and worker, with no harness:

```bash
docker agent run <scratch>/team.yaml --working-dir <scratch> \
  --session-db <scratch>/sessions.db --exec --json --safety autonomous \
  "Verify the native delegation and execute_probe tool path."
```

The root had only native `transfer_task`; the worker had one native script tool,
`execute_probe`. That tool generated a random proof value, wrote it to a real
file in the scratch directory, and returned it. The value was not in the prompt.
The JSON event stream and on-disk proof agreed:

```text
root: transfer_task -> worker
worker: execute_probe
worker: NATIVE_TOOL_ab22e03a5e1b040152bed578
root: PROBE_RESULT: NATIVE_TOOL_ab22e03a5e1b040152bed578
exit 0
```

This exercises live Claude inference, streamed tool calls, native sequential
delegation, script execution in the requested working directory, tool-result
history, and the return to the root agent. Probe files and its session database
were removed; the authenticated proxy service and login volume were retained.
No existing workflow was changed. Other models, parallel delegation, permission
denials, compaction, thinking behavior and long-running token refresh remain
unverified by this receipt.

### Current Claude models

Also on 2026-10-15, using the same image/dependency lock and a read-only
`models.json` mount:

- A plain Sonnet 5.5 request failed: upstream HTTP 400 instructed the caller to
  use `between_tools` instead of `thinking: disabled`; the proxy surfaced it as
  a 502 `upstream_error`.
- Adding explicit `reasoning_effort: high` returned `CURRENT_MODEL_OK`.
- A native two-turn tool probe using
  `provider_opts.extra_body.reasoning_effort: high` on Sonnet 5.5 executed two
  real script calls and returned both generated values, exit 0.
- Haiku 5.5 with explicit `medium` effort passed the same two-turn probe.
- The normal Compose service was recreated with the catalogue mount; its login
  volume was retained and both current model IDs appeared in `/v1/models`.
- `j5 pr-reviewer review --pr 12 --project <scratch> -- --exec --json --safety autonomous`
  completed on `pi/claude-sonnet-5-5`, with initial/final context gates and native
  read-only file inspection. See the [workflow receipt](../../workflows/pr-reviewer/README.md#verification-receipt).

These receipts establish the exercised text/tool paths, not preserved thinking
visibility, arbitrary signed-history portability, or every new model capability.
