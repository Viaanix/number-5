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

The build context permits only `package.json`, `bun.lock` and `patch-usage.ts`. Credentials and the
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

## Get the image

CI publishes the image to GitHub Packages as `ghcr.io/viaanix/j5-pi-openai-proxy:<tag>`
(`linux/amd64` and `linux/arm64`); the tag is the one in `compose.yaml`. The package is
private to the Viaanix organisation, so pulling it needs a login, once per machine:

1. Create a **classic** personal access token with only the `read:packages` scope and
   authorise it for Viaanix SSO if the organisation requires that.
2. `echo "$TOKEN" | docker login ghcr.io -u <your-github-username> --password-stdin`

The pull itself is the first command in the next section (every compose command needs the
bearer token exported first, even `pull`).

Skipping the login is safe: when the pull is denied, `docker compose up` builds the same
Dockerfile and lockfile locally instead (checked: the denied pull was followed by a build and
exit 0). The only cost is a slower first start. The image contains no credentials, so nothing
private ships in it. Your Claude login is created inside *your* `pi-auth` volume in the next
section; **every person logs in with their own account, never a shared one**, and the volume
must never be copied between machines.

The image refuses to start without `PI_PROXY_AUTH_TOKEN` (exit 64). Without that guard the
proxy starts with no authentication at all and serves whatever login is in the volume, so
`docker run -p 4141:4141 <image>` would have exposed it to the network.

## Build and log in

With number-5 installed, **`j5 setup --proxy --login` does everything in this section**: it creates the
token if you have none, starts the proxy and opens Pi so you can log in
([docs/packaging.md](../../docs/packaging.md#what-j5-setup-does)). The manual steps are below, from the
repository root:

```bash
cd containers/pi-openai-proxy
export PI_PROXY_AUTH_TOKEN="$(openssl rand -hex 32)"
docker compose pull   # or `docker compose build`, which needs no registry login

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

## Local patch: token usage

The pinned proxy reports Pi's `input` as `prompt_tokens`, which for Anthropic is only the
uncached input. With prompt caching, a ~9,650-token prompt came back as `prompt_tokens: 4`,
`completion_tokens: 4`, `total_tokens: 9650`, so Docker Agent's token display, context size
and compaction trigger saw about 0.04% of the real context and its counters never accumulated
([gotcha](../../docs/docker-agent/gotchas.md#token-counters-through-the-proxy-ignore-cached-input-so-compaction-cannot-trigger)).

`patch-usage.ts` runs at build time and replaces `mapUsage()` so `prompt_tokens` includes cache
reads and writes, with `prompt_tokens_details.cached_tokens` and `cache_write_tokens` for Docker
Agent to subtract. It must match exactly one function: if the pinned package changes, the build
fails instead of shipping an unpatched proxy.

Checked offline in a throwaway container (no network, no login): the patched file differs from
the original only in that function, 4 + 9000 + 642 input tokens give `prompt_tokens` 9646 with
`completion_tokens` 4 and `total_tokens` 9650, and running the patch step a second time exits 1.

Checked end to end on 2026-10-15, after `docker compose build` and a recreate: a streamed request
with a ~9,650-token prompt returned `prompt_tokens` 9646, `completion_tokens` 4, `total_tokens` 9650
(it was `prompt_tokens` 4 before the patch), with `cache_write_tokens` 9642 on the first call and
`cached_tokens` 9642 on repeats; the non-streamed response agreed. Not yet watched: a real run's
token counter accumulating in the Docker Agent sidebar.

## Upstream status and the fork

Treat `@victor-software-house/pi-openai-proxy` as abandoned: 4.9.5 is the latest release (published 2026-05-06), the repository's last push was 2026-06-08, and there is no open issue about what we patch. We keep it pinned and carry small build-time patches (`patch-usage.ts`), each of which fails the build if the package stops matching.

A fork exists at [`vx-daniel/pi-openai-proxy`](https://github.com/vx-daniel/pi-openai-proxy), unchanged from upstream so far. **Revisit and switch to it once we need more than a few fixes**, or one that does not fit a build-time patch. A fork does not change the Opus 5.5 rejection, which comes from Pi's client identity and not from this proxy.

## Share it with the team (maintainers)

**Publishing.** `.github/workflows/proxy-image.yml` runs when a build input changes
(`Dockerfile`, `.dockerignore`, `package.json`, `bun.lock`, `patch-usage.ts`) or `compose.yaml`.
On a pull request it builds and smoke-tests only. On a push to `main` it also publishes the tag
named in `compose.yaml`. The smoke test checks that the usage patch is in the shipped file, that
the image exits 64 without a token, that it answers 401 to a missing or wrong bearer and 200 to the
right one, and that it runs as UID 1000.

**Bump the tag when a build input changes.** The last number in the `compose.yaml` image tag
(`4.9.5-1`) is the revision. CI records a hash of the build inputs in an image label. If the
tag is already published from the same inputs it skips quietly, for example after a `compose.yaml`
edit that is not a bump. If the inputs differ it fails and tells you to bump, because a machine
that already pulled the old image under that tag would otherwise keep running it with no warning.

**Who can read the package.** The package is linked to this repository (the workflow's source label
does it) and **inherits the repository's access**. Observed on 2026-10-15, after the first publish
of `4.9.5-1`:

- The package is **Private**, although the repository is public. Its page returns 404 to an
  anonymous visitor and the registry refuses an anonymous pull, so a public repository does not
  make a linked package public.
- The Viaanix base permission is `none`, and `number-5` had only one direct collaborator, so the
  package's *Inherited access* list showed one person. Nobody else could pull it.

So to give people access, grant it **on the repository**, not on the package: *Repository
Settings → Collaborators and teams → Add teams*, pick the team, role **Read**. Read is enough to
pull; do not use Write, which also lets them push to the repository. Publishing needs no team
access: CI publishes through the repository's own Actions access. The package's *Package settings*
page should then list that team's members under *Inherited access*; check that it matches who you
meant. Keep *Inherit access from source repository* on unless the package's readers should differ
from the repository's.

Read-only checks anyone can run:

```bash
# Anonymous pull must fail: no token is issued and the manifest is refused (403), the same as for a
# package that does not exist. A public package would answer 200.
token=$(curl -s "https://ghcr.io/token?scope=repository:viaanix/j5-pi-openai-proxy:pull" | jq -r .token)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $token" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  https://ghcr.io/v2/viaanix/j5-pi-openai-proxy/manifests/<tag>
```

The package page is `https://github.com/Viaanix/number-5/pkgs/container/j5-pi-openai-proxy`, and its
settings are under the org: `https://github.com/orgs/Viaanix/packages/container/j5-pi-openai-proxy/settings`.

Not verified: that fine-grained tokens cannot pull from `ghcr.io` (the instructions say "classic"
because that is what the Container registry documentation describes), and that a team member can
pull after being given Read. Have the first teammate try it and record the result here. As far as I
found, GitHub has no REST endpoint for a package's visibility or access, so changing them is a
settings-page step.

**Never publish a login.** The image is built from `package.json`, `bun.lock` and
`patch-usage.ts` only (`.dockerignore` excludes everything else). Do not add `COPY` lines for
anything under `~/.pi`.

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
- Image entrypoint (2026-10-15): with no `PI_PROXY_AUTH_TOKEN`, and with an empty one, the
  container exits 64 with a message; before the guard the same image answered `/v1/models` with
  HTTP 200 and no token. With a token: no bearer → 401, wrong bearer → 401, right bearer → 200;
  extra arguments reach the proxy; `bun` is PID 1 and `docker stop` exits 0.
- Registry fallback (2026-10-15, Docker Compose on this host): with `image:` and `build:` both set,
  a pull denied by the registry was followed by a local build and exit 0.

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
