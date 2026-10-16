# Pi OpenAI proxy container

A standalone OpenAI Chat Completions endpoint for Docker Agent Path C, using
[`@vx-daniel/pi-openai-proxy`](https://github.com/vx-daniel/pi-openai-proxy), our fork of `@victor-software-house/pi-openai-proxy`.
Docker Agent owns the agent loop and tool execution; Pi supplies model access and
credential handling. This does not change the existing Claude Code harness workflows.

## Pinned components

- Node 24.22.0 (`node:24.22.0-bookworm-slim`), pinned by multi-platform digest. The fork moved from
  Bun to Node; the earlier images ran Bun 1.4.2.
- The proxy: a build of the fork [`vx-daniel/pi-openai-proxy`](https://github.com/vx-daniel/pi-openai-proxy)
  (pre-release `v4.9.6-j5.3`, fork `dev` at `7664589`): upstream 4.9.6 plus the Pi 1.x port, the
  `prompt_tokens` fix, LogTape logging with a `/healthz` endpoint, a log level and format setting,
  and an idle (not total) upstream timeout. It is installed from the release asset URL in
  `package.json`, and `package-lock.json` records the tarball's integrity hash (the asset's sha256 is
  `c793f174cec0e2671d8284ee6834cedb1340aa5dc53e3ec306949b6e26c0c941`).
- Pi 1.3.0 (`@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui`): the model adapter and the CLI used
  for subscription login. Its Anthropic client identifies as Claude Code 2.1.280.
- Every resolved dependency is recorded in `package-lock.json`; builds use `npm ci` and do not
  run dependency lifecycle scripts.

The build context permits only `package.json` and `package-lock.json`. Credentials and the
host's Pi configuration/extensions are not copied into the image or bind-mounted. No model
catalogue file is mounted: see the next section.

## Current models

Pi 1.x ships the current Claude catalogue as built-in definitions, including `claude-haiku-5-5`,
`claude-sonnet-5-5`, `claude-opus-5-5` and `claude-fable-5-1`, with the metadata that selects
adaptive thinking. The image therefore has **no `models.json`**: a hand-written entry for a model
Pi already knows replaces its built-in definition and drops that metadata, which sends the legacy
token-budget form of thinking and makes `xhigh` the same as `high` on Sonnet and Haiku (receipts in
[the gotchas](../../docs/docker-agent/gotchas.md#our-modelsjson-entries-replace-pis-built-in-model-definitions-and-with-them-adaptive-effort)).
Add a `models.json` only for a model Pi does not list, and check what Pi sends for it.
Catalogue presence is not a guarantee of account access or complete feature parity.

Through the image built from this directory (2026-10-16, Pi 1.3.0), the request Pi sends for
`claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` and `claude-fable-5-1` is adaptive
thinking with the level carried as a managed-effort message, and `claude-opus-4-7` sends
`output_config.effort`; all four levels (`low`, `medium`, `high`, `xhigh`) differ on all five.

Docker Agent does not map `thinking_budget` to `reasoning_effort` for a Claude
model using its OpenAI client. Set `provider_opts.extra_body.reasoning_effort`
instead; every team here sets it. With Pi 0.73 and no effort the adapter sent
`thinking: disabled`, which Sonnet 5.5 rejects; that was not re-checked on Pi 1.x.

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
  /app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
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

Inside Pi, enter `/login`. Pi 1.x lists providers ("Select provider to configure"): choose
**Anthropic**, then **Browser login** (or **Copy code login (headless)** on a machine without a
browser). Open the displayed authorization URL in your host browser. The login
container does not publish an OAuth callback port; if the browser redirects to an
unreachable localhost URL, paste the complete redirect URL or code into Pi's manual input.
Exit Pi when login completes. Do not paste credentials into chat or commit them.
The menu above was read from Pi 1.3.0's screen on 2026-10-16 without completing a login; the
login flow itself has not been run on Pi 1.x.

`--offline` disables Pi's startup downloads, not the interactive login request.
Warnings about missing `fd` and `ripgrep` are expected: this image uses Pi for
login, not coding tools. The proxy does not execute Pi tools.

Pi stores its login in the Compose-managed `pi-auth` volume, mounted at
`/home/node/.pi/agent`. A volume made by the earlier Bun images (mounted at `/home/bun/.pi/agent`)
works unchanged under the same Compose volume name: the `node` user is UID 1000, like `bun`, and the
files in it are owned by 1000 (checked 2026-10-16 on a copy of one). The directory is writable so
token refreshes and lockfiles
can persist. The host's `~/.pi/agent` is never mounted. Stop a running proxy before
using this login command again.

**An empty `models.json` in an older volume.** Before the Pi 1.x image, Compose mounted this
repository's `models.json` into that directory, which left a root-owned, 0-byte `models.json` in
the volume. The Pi 1.x image mounts nothing there, so on such a volume the proxy logs
`[warn] models.json load error: Failed to parse models.json: JSON Parse error: Unexpected EOF`
and continues with the built-in catalogue (17 models for the login it was tried with; nothing
else breaks). To silence it, stop the proxy and delete the empty file, then start it again:

```bash
docker compose stop proxy
docker run --rm --user root -v j5-pi-openai-proxy_pi-auth:/v --entrypoint sh \
  ghcr.io/viaanix/j5-pi-openai-proxy:4.9.6-2 -c 'test ! -s /v/models.json && rm -f /v/models.json'
docker compose up --wait
```

The `test ! -s` guard deletes the file only when it is empty, so a `models.json` you wrote
yourself is kept. Seen and fixed on 2026-10-16 on the volume this was written from; a new volume
never has the file.

## Logs and settings

The fork logs with LogTape, one JSON object per line on stderr when there is no terminal, which is
the case for a container started by Compose: `@timestamp`, `level`, `message`, `logger`, `properties`. Each chat
request logs `Chat request for "<requested>" resolved to "<provider>/<model>"` at `info`
(logger `pi-openai-proxy.server.chat`; properties include `requestId`, `clientRequestId` and
`stream`), which replaces the `chat_request` line of the earlier images. Checked 2026-10-16: a
distinctive phrase sent in a prompt appeared 0 times in the logs.

Compose passes four settings through **only when they are set**, in the shell or in
`~/.config/cagent/.env` next to the token. Nothing is set by default, so the fork's own defaults
apply. They are bare keys in `compose.yaml` on purpose: a default written there would always set the
variable, and in the fork an environment variable beats `proxy-config.json`, so `logLevel` and
`upstreamTimeoutSec` in that file could never take effect. Checked with `docker compose run … env`:
a variable set in the env file reaches the container, and one that is not set is absent (not an
empty string, which the fork would warn about at every start).

| Variable | Unset means | Effect |
|---|---|---|
| `PI_PROXY_LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warning`, `error` or `fatal`. An invalid value is ignored with a warning. Checked: `debug` adds debug lines. |
| `PI_PROXY_LOG_FORMAT` | JSON lines (the fork's default without a terminal) | `pretty` prints lines for reading `docker compose logs` by eye. Checked with `pretty`. |
| `PI_PROXY_UPSTREAM_TIMEOUT_MS` | 120000 | An **idle** timeout: how long the provider may send nothing, in milliseconds. It restarts on every upstream event. The fork's config allows 5 to 600 seconds. Checked: the container honors it (next paragraphs). |
| `TZ` | UTC | The time zone `pretty` logs print in, for example `TZ=America/Chicago`. Checked: `new Date()` in the image reports Central time with it set and UTC without. JSON lines keep a UTC `@timestamp` either way. |

`j5 setup` hands `~/.config/cagent/.env` to Compose only when the token comes from that file. If you
export the token in your shell instead, export these there too. docker-agent also loads that file,
so a `TZ` there may reach its tools as well (not checked); set it in the shell instead if you only
want it for the proxy.

**The timeout is an idle timeout (build `v4.9.6-j5.3`; measured 2026-10-16, image `4.9.6-2`).** The
previous build, `v4.9.6-j5.2`, counted the whole call: at the 5 s minimum it cut a streaming essay
while 223 chunks were flowing, and a silent thinking phase, both at exactly 5.0 s, and an Opus 5.5
`xhigh` turn takes about 66 s, so the 120 s default would have cut any turn above roughly 14,000
tokens (the teams allow up to 32,768). The timer now restarts on every upstream event.

- **How long Anthropic is silent during thinking.** With `PI_PROXY_LOG_LEVEL=trace`, one streamed
  Opus 5.5 `xhigh` turn (65.6 s) logged 397 upstream events. Thinking arrives as `thinking_delta`
  events, the first event came after 0.8 s, the median gap was 49 ms, and the **largest gap was
  4.0 s**. The 120 s default is about thirty times that. One turn was measured, so a much longer
  one may differ.
- **Long but steady responses survive a 5 s limit.** The same prompts that were cut at 5.0 s now
  finish: the Haiku essay in 10.0 s (not streamed) and 10.3 s (streamed, 487 chunks), the Opus
  `xhigh` puzzle in 32.7 s streamed and 70.4 s not streamed.
- **A real stall is cut, and the failure has two shapes.** With the limit at 5 s, the container's
  network was cut 3 s into a request, so the upstream connection went silent. Not streamed: HTTP 504
  after 8.0 s, body `{"error":{"message":"Upstream request timed out","type":"server_error","param":null,"code":"timeout"}}`.
  Streamed: HTTP 200 was already sent and the text that had arrived stays delivered, then
  `data: {"error":{"message":"Upstream timeout: the provider sent nothing for 5 s","type":"server_error","param":null,"code":"upstream_error"}}`
  and `data: [DONE]`. Not tested: what Docker Agent does with that error event.

So the default needs no raising. The maximum is 600000 (10 minutes), which would only let a stalled
connection hang that long.

The healthcheck is `GET /healthz`, which needs no token and says the process listens and Pi's model
runtime loaded. It does not say a login exists (`j5 setup --check` asks `/v1/models` for that).

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

## Token usage

Pi reports its `input` as the uncached input only: with Anthropic prompt caching, cache reads and
writes arrive separately. Upstream 4.9.5 passed `input` through as OpenAI's `prompt_tokens`, so with
caching a ~9,650-token prompt came back as `prompt_tokens: 4`, `completion_tokens: 4`,
`total_tokens: 9650`, and Docker Agent's token display, context size and compaction trigger saw about
0.04% of the real context and its counters never accumulated
([gotcha](../../docs/docker-agent/gotchas.md#token-counters-through-the-proxy-ignore-cached-input-so-compaction-cannot-trigger)).

The fork build fixes `mapUsage()` in its source: `prompt_tokens` is `input + cacheRead +
cacheWrite`, with `prompt_tokens_details.cached_tokens` and `cache_write_tokens` for Docker Agent to
subtract. This replaced a build-time patch (`patch-usage.ts`, removed with the Pi 1.x move), so
there is no step here that can silently stop matching. The fork's unit tests pin the mapping for both
the non-streamed and the streamed usage chunk, and CI's smoke test checks the shipped file still
contains `prompt_tokens_details`.

Checked end to end on 2026-10-16, through this directory's image run with the compose settings
(read-only root, no capabilities, `no-new-privileges`) and a copy of a Claude login: a ~13k-token
prompt on `claude-sonnet-5-5` returned `prompt_tokens` 13,367 (4 uncached + 13,363) with
`cache_write_tokens` 13,363 on the first streamed call and `cached_tokens` 13,363 on the second
streamed call and on a non-streamed call. Earlier (2026-10-15, with the build-time patch on 4.9.5)
a ~9,650-token prompt gave `prompt_tokens` 9,646. Not yet watched: a real run's token counter
accumulating in the Docker Agent sidebar.

## Prompt cache lifetime

Pi marks the prompt for Anthropic's cache. By default the cache lives 5 minutes, so an agent that
is idle for longer (for example while a long test suite runs) writes its whole context again on its
next turn. `compose.yaml` sets `PI_CACHE_RETENTION=long`, which makes Pi send `cache_control` with
`ttl: "1h"` (captured from Pi 1.3.0's request for Sonnet 5.5 and Opus 4.7; without it the field is
absent).

Measured 2026-10-16 through two containers of this image (one with the setting) and a copy of a
Claude login, a ~13k-token prompt unique to each, sent twice 330 seconds apart on
`claude-sonnet-5-5`:

| | First call | After 330 s |
|---|---|---|
| Default (5 minutes) | `cache_write_tokens` 13,360 | `cache_write_tokens` 13,360, `cached_tokens` 0: **miss** |
| `PI_CACHE_RETENTION=long` | `cache_write_tokens` 13,366 (accepted through the subscription login) | `cached_tokens` 13,366, `cache_write_tokens` 0: **hit** |

**The tradeoff was not measured.** On Anthropic's API a one-hour cache write costs more than a
five-minute one, so a run that never idles past 5 minutes pays a little more for nothing; how this
counts against a subscription's usage limits is not something this test could show. It is read at
request time (no image rebuild or tag bump). Remove the line from `compose.yaml` and recreate the
container to go back to the default.

## Upstream status and the fork

Treat `@victor-software-house/pi-openai-proxy` as abandoned: 4.9.5 is the latest npm release (published 2026-05-06), the repository's last push was 2026-06-08, and there is no open issue about what we changed. This image runs a build of our fork, [`vx-daniel/pi-openai-proxy`](https://github.com/vx-daniel/pi-openai-proxy), instead. Its PR #1 (merged 2026-10-16) ports the proxy to Pi 1.x (`ModelRuntime` replaces `AuthStorage` and `ModelRegistry.create()`) and fixes `prompt_tokens` at source; PR #2 adds a `chat_request` log line naming the requested and the resolved model of each chat request; PR #3 aligns its docs.

**Updating the proxy build.** Use a GitHub release asset of the fork, built with `pnpm install --frozen-lockfile && pnpm pack`. Here: point the URL in `package.json` at that asset, regenerate `package-lock.json` (`npm install --package-lock-only --ignore-scripts` in this directory; it records the asset's integrity hash), and bump the image tag in `compose.yaml`. The build fails if the asset changes. A tarball packed independently from a clean clone of `dev` had the same sha256 as the fork's release asset (`becd0133…`), so the build is reproducible. The fork's own release workflow (semantic-release on `main`) attaches no tarball, and its package is published to a restricted registry that a public image build cannot read, so until that changes this image uses a pre-release asset such as `v4.9.6-j5.2`.

**Why Pi's version decides which models work.** The Opus 5.5 rejection comes from the client version Pi's Anthropic client sends (`user-agent: claude-cli/<version>`), not from this proxy. Read from the published `@earendil-works/pi-ai` packages (`claudeCodeVersion` in `dist`), checked 2026-10-16:

| `pi-ai` release | Sends | Serves |
|---|---|---|
| 0.75.0 to 0.84.4 (0.75.0, 0.80.9, 0.84.0, 0.84.3, 0.84.4 read) | 2.1.75 | Not Opus 5.5, not Fable 5.1 |
| 0.85.0 to 0.86.0 (both read) | 2.1.251 | Fable 5.1's floor is 2.1.251 (from Anthropic's error message); not tried on these releases |
| 1.0.0 to 1.3.0 (1.0.0, 1.1.0, 1.2.0, 1.3.0 read) | 2.1.280 | Opus 5.5 and Fable 5.1 answered through this directory's image, 2026-10-16 |

Releases between the ones listed were not read. Anthropic's errors named 2.1.280 for Opus 5.5 and 2.1.251 for Fable 5.1 ([gotcha](../../docs/docker-agent/gotchas.md#opus-55-is-rejected-for-the-pi-proxys-subscription-login)). CI's smoke test fails the build if the Pi in the image sends anything older than 2.1.280.

### Other forks reviewed (2026-10-16)

Both are forks of the same upstream, 0 stars, compared with upstream `main` through GitHub's compare API.

| Fork | Ahead of upstream | What it adds | Pi it targets |
|---|---|---|---|
| [`laixintao/pi-openai-proxy`](https://github.com/laixintao/pi-openai-proxy) | 3 | Port to Pi 0.84.3; a `chat_request` log line naming the model a request resolved to; CORS preflight handling | 0.84.3 |
| [`thomasgauthier/pi-openai-proxy`](https://github.com/thomasgauthier/pi-openai-proxy) | 2 | Port through every Pi release 0.74 to 0.84.1, with a migration log (`PI-MIGRATION-LOG.md`) | 0.84.1 |

- **Neither unlocks the new models.** Both stop at Pi 0.84.x, which sends 2.1.75.
- **Both ports match ours.** `ModelRuntime`, `getAvailableSnapshot()`, `getAuth()` for the pre-check, completions through the runtime, and `pending` and `deferred` mapped to `stop`. thomasgauthier forwards `auth.baseUrl` by hand; `ModelRuntime.prepareRequest` already applies it (read in `pi-coding-agent` 1.3.0), so ours needs no such step. Both refresh the registry in the extension before reading it, which the fork's branch now does too.
- **Neither touches `mapUsage()`.** The cache-token fix is ours alone.
- **Not adopted: laixintao's CORS.** It answers every `OPTIONS` before proxy auth and reflects any `Origin` with `access-control-allow-credentials: true` and private-network access allowed, on a proxy that fronts a Claude login. The bearer token is still required for real requests, but a browser page could now reach a localhost proxy that upstream refuses by default, and docker-agent is not a browser. Skip it unless a browser client needs it, and then restrict the origins.
- **The `chat_request` log line is now in the fork.** Its LogTape rewrite logs the requested and the resolved model per request at `info` (see "Logs and settings"); nothing is taken from laixintao's branch.

### Anthropic's own OpenAI-compatible endpoint

Anthropic documents an official OpenAI-compatible endpoint, `https://api.anthropic.com/v1/`, used with a Claude **API key** ([OpenAI SDK compatibility](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk), read 2026-10-16). It would need no Pi, no proxy and no client-version check, and docker-agent can point at it as a custom OpenAI-compatible endpoint. It is a different trade, not a drop-in: none of this was tested here (we have no API key for it), and every row below is Anthropic's statement.

| Our use | The endpoint |
|---|---|
| `reasoning_effort` (the `--effort` flavors) | **Ignored.** Thinking is set with a `thinking` field instead; Claude 5 models think adaptively by default. The `effort-*` flavors would change nothing there. |
| Prompt caching | **Not supported** (only in the native API and SDKs). Every request is billed as fresh input, and `usage.prompt_tokens_details` is always empty. |
| `tool_choice` `required` or a named tool | Errors on Opus 5.5, Sonnet 5.5, Fable 5.1 and Mythos 5.1; `auto` works. |
| `strict` tool schemas | Ignored. |
| System and developer messages | Hoisted and joined into one top-level `system` field. |
| `temperature`, `top_p` | A 400 for values other than the default on Claude 4.7 and later; omit them. |
| Thinking output | Not returned. |
| Status | Anthropic calls it "primarily intended to test and compare model capabilities", "not considered a long-term or production-ready solution for most use cases". |

Billing is per token on an API key, not the subscription. Anthropic's recommendation for the full feature set is the native Claude API, which docker-agent's own `anthropic` provider uses; that route was not tried here either.

## Share it with the team (maintainers)

**Publishing.** `.github/workflows/proxy-image.yml` runs when a build input changes
(`Dockerfile`, `.dockerignore`, `package.json`, `package-lock.json`) or `compose.yaml`.
On a pull request it builds and smoke-tests only. On a push to `main` it also publishes the tag
named in `compose.yaml`. The smoke test checks that the shipped proxy reports `prompt_tokens_details`,
that Pi's Anthropic client sends Claude Code 2.1.280 or newer, that the image exits 64 without a
token, that it answers 401 to a missing or wrong bearer and 200 to the right one, that `/healthz`
answers 200 with no token, and that it runs as UID 1000.

**Bump the tag when a build input changes.** The last number in the `compose.yaml` image tag
(`4.9.6-2`) is the revision. CI records a hash of the build inputs in an image label. If the
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

**Never publish a login.** The image is built from `package.json` and `package-lock.json`
only (`.dockerignore` excludes everything else). Do not add `COPY` lines for
anything under `~/.pi`.

## Verification receipts

### Node image (`4.9.6-2`), 2026-10-16

Linux amd64, Node 24.22.0, the fork's pre-release `v4.9.6-j5.3` (`dev` at `7664589`; asset sha256
`c793f174…`, equal to the release's recorded hash and to a tarball packed independently from a clean clone):

- The image built through `docker compose build` (`npm ci`, 534 MB). Run on an empty volume with the
  compose hardening flags: `/healthz` 200 with no token, 401 without a token, 200 with it on
  `/v1/models` (0 models), UID 1000, exit 64 without `PI_PROXY_AUTH_TOKEN`, and the log level and
  format settings changed what was logged.
- The same dependencies and base in a throwaway image, on a copy of the existing login: 17 models
  including Opus 5.5 and Fable 5.1; one request each answered on `claude-opus-5-5`,
  `claude-fable-5-1`, `claude-haiku-5-5` and `claude-sonnet-5-5`. A ~28k-token prompt wrote the
  cache on the first call and read it on the second (`prompt_tokens` 27,937 both times,
  `cached_tokens` 27,933). A streamed request returned usage and `[DONE]`; a tool call on
  `claude-opus-5-5` returned `get_weather {"city":"Oslo"}`. `/healthz/creds` listed one provider,
  `anthropic`, type `oauth`, 17 models, and no secret.
- Pi's terminal UI starts under Node (v1.3.0, "No models available. Use /login"). The login menu
  itself was not read again under Node.

**Never test with a copy of a live login.** That copy's access token was 7 hours expired, so the
first request made Pi refresh it and Anthropic replaced the refresh token too. The live proxy's copy
of the old refresh token was then useless. It was repaired by moving the new `auth.json` into the
live volume and restarting the proxy (4 of 4 requests then answered), but whether the new refresh
token survives is only known at the next refresh. Test against an empty volume, or read the
login's `expires` first and stop if it is within a day.

The image was then running on the live proxy (recreated 15:33 UTC): it is
healthy, serves 17 models, `claude-opus-5-5` answers, and `GET /healthz/creds?verify=true` returns
`verified: true`. That verifies the current access token; the rotated refresh token is still only
proven at the next refresh (about 22:30 UTC).

Not verified: completing a login or a token refresh under Node; Docker Agent teams against this
image; the arm64 build (CI builds it).

### Pi 1.x image (`4.9.6-1`), 2026-10-16

Linux amd64, Bun 1.4.2, a copy of one existing Claude login in a throwaway volume (the live proxy
and its volume were not touched):

- `docker build` of this directory completed. The frozen lockfile installed Pi 1.3.0
  (`pi-ai`, `pi-coding-agent`, `pi-tui`) and the fork's release tarball, whose hash `bun.lock` records.
- The CI smoke commands, run by hand against the built image: `prompt_tokens_details` is in the
  shipped file; Pi sends Claude Code 2.1.280, and the version check fails for 2.1.75; exit 64
  without a token; 401 / 401 / 200 for no, wrong and right bearer; UID 1000.
- With the compose settings (`--read-only`, `--tmpfs /tmp`, `--cap-drop ALL`,
  `--security-opt no-new-privileges:true`, `--init`): the proxy started with an empty volume
  (0 models, no errors) and with the login copy (17 models, no write errors). Pi wrote one new file,
  `models-store.json` (2 bytes), into the volume; `auth.json` kept the same keys.
- One request each answered `OK` on `claude-opus-5-5`, `claude-fable-5-1`, `claude-sonnet-5-5`,
  `claude-haiku-5-5` and `claude-opus-4-7`. A streamed and a non-streamed request with a ~13k-token
  prompt reported `prompt_tokens` 13,367 with the cache written on the first call and read on the
  next two. A tool call on `claude-opus-5-5` returned `get_weather {"city":"Oslo"}`.
- The `chat_request` line was logged once per request (9 for these calls), with the canonical model
  and the stream mode; the prompt text appeared nowhere in the logs.
- The request Pi builds, captured inside the image with no network and no `models.json`: adaptive
  thinking and four distinct effort levels on all five models above.
- `/login` in the image's Pi 1.3.0 UI, opened with the arguments `j5 setup --login` passes:
  "Select provider to configure" listing Anthropic, then "Select Anthropic login method" with
  "Browser login (default)" and "Copy code login (headless)". The old path
  `/app/node_modules/@mariozechner/...` no longer exists in the image; `j5 setup --login` and the
  command above now use `@earendil-works/pi-coding-agent/dist/bundle/cli.js`.

Not verified: completing a login on Pi 1.x; OAuth token refresh under Pi 1.x; Docker Agent teams
running against this image; the live proxy swapped to it; long sessions; the arm64 build (CI builds
it).

### 4.9.5 image, Pi 0.73 (2026-10-15), kept as history

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

### Current Claude models (4.9.5 image, with the since-removed `models.json` mount)

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
