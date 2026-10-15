# Installing and releasing number-5 as a package

number-5 is published to GitHub Packages as `@viaanix/number-5`: the `j5` launcher, every team under `workflows/`, the skills, and the proxy's Compose files. A teammate installs it with Bun and runs `j5 setup`; nobody needs a clone. A clone still works the same way as before ([launcher.md](launcher.md#install)) and is how you change number-5 itself.

## Install (teammates)

Needs [Bun](https://bun.sh) 1.4.2 or newer, Docker with the `docker agent` plugin, `git` and `gh`. Run `j5 setup` afterwards to check all of that.

1. Make a **classic** personal access token with only the `read:packages` scope, and authorise it for Viaanix SSO if the organisation requires it. It is the same kind of token the proxy image needs, so one token serves both. Keep it out of any repository.
2. Tell Bun where `@viaanix` packages live, once, in `~/.bunfig.toml`:

   ```toml
   [install.scopes]
   "@viaanix" = { token = "$NUMBER5_REGISTRY_TOKEN", url = "https://npm.pkg.github.com/" }
   ```

   and export `NUMBER5_REGISTRY_TOKEN` in your shell startup file. The token stays in the environment variable, not in the file.
3. Install and set up:

   ```bash
   bun add -g @viaanix/number-5
   j5 --version
   j5 setup                 # checks your tools, installs the skills the teams read
   j5 setup --proxy --login # optional: start the local proxy and log it in (pr-reviewer, issue-team)
   ```

   Open a new terminal if `j5` is not found: Bun prints the global bin directory to add to `PATH`.

   **Using `npm` instead of `bun add`?** `j5` still runs on Bun, but the package can be fetched with `npm`. Put the scope and token in `~/.npmrc` (GitHub's documented form for its npm registry; not yet run against this package) and install globally:

   ```ini
   @viaanix:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=<the token from step 1>
   ```

   ```bash
   npm install -g @viaanix/number-5
   ```

   That file holds the token itself, so keep it out of any repository and owner-only.

   **`E404 … registry.npmjs.org/@viaanix%2fnumber-5`** means the scope is not configured: the tool asked npmjs.org, never GitHub. It says nothing about whether you have access. Add the scope line above (or the `bunfig.toml` block) and try again. A **401** from `npm.pkg.github.com` means the scope is configured but the token is missing, wrong, or not authorised for Viaanix SSO. A **404** from `npm.pkg.github.com` would mean your account cannot see the package, so check you have Read on the repository.

**Upgrade:** `bun update -g @viaanix/number-5`, then **`j5 setup` again**. The skills are copies in `~/.agents/skills/`, and the teams read their framework references from there; `j5 setup --check` reports a skill as `stale` when the copy no longer matches the installed version.

**Remove:** `bun remove -g @viaanix/number-5`. The skill copies in `~/.agents/skills/` are left behind; only directories holding a `.installed-by-number-5` file are ours to delete.

## What `j5 setup` does

| Command | Does |
|---|---|
| `j5 setup` | Checks `bun`, `git`, `gh` (and that it is logged in), `docker`, the docker-agent plugin and its version; installs or refreshes the skills. Exit 1 only when a required tool is missing; a warning (gh not logged in, untested docker-agent version, stopped daemon) exits 0 |
| `j5 setup --check` | The same checks, **changes nothing**; reports skills as `missing` or `stale` |
| `j5 setup --proxy` | Also: creates `PI_PROXY_AUTH_TOKEN` in `~/.config/cagent/.env` if it has none (owner-only, never printed, never replaced), runs `docker compose up -d --wait` on the package's own `containers/pi-openai-proxy/compose.yaml`, then asks the proxy how many models it serves |
| `j5 setup --login` | Implies `--proxy`. When the proxy has no models yet, opens Pi in the proxy container so you can `/login` with **your own** Claude account, then re-checks |

A skill directory that number-5 did not create (no marker file) is never replaced. A token already in your shell environment or in the env file is used as is.

`--proxy` restarts the proxy if its image or settings changed, which interrupts a run in progress. Do it between runs.

## Releasing (maintainers)

1. Bump `version` in `package.json` and merge that to `main`.
2. Tag the merged commit and push the tag:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

3. `.github/workflows/publish-package.yml` publishes. It refuses unless the tag equals the `package.json` version and the commit has passing `linux`, `macos` and `windows` jobs from the `check` workflow. If you tag before those finish, wait and re-run the workflow.

The package is linked to this repository (`repository` in `package.json`), so **access follows the repository's**, as for the proxy image: give a team Read on the repository (see the [proxy README](../containers/pi-openai-proxy/README.md#share-it-with-the-team-maintainers)) and its members can install. After the first publish, check the package's page and *Package settings* the same way.

**What ships.** `package.json`'s `files` is an allow-list: `launcher/src`, `workflows` (minus every `test` directory), `skills`, `containers/pi-openai-proxy`. Add a directory there when something shipped starts to need it; check with `bun pm pack --ignore-scripts --dry-run`. Nothing outside those directories is reachable from an installed copy, which is why `launcher/src` finds teams, skills and the proxy files only by paths relative to itself.

**Scripts are skipped** (`--ignore-scripts`) when packing and publishing: `prepare` runs `vp config` (git hooks), which needs the dev dependencies and means nothing in a tarball. Without the flag, `bun pm pack` fails where those are not installed.

## Receipts

2026-10-15, Linux, Bun 1.4.2:

- `bun pm pack --ignore-scripts` with the allow-list: 85 files, about 165 KB. No `test` directories, no images, no docs. The helper scripts under `workflows/*/bin/` keep mode 775 in the tarball, which docker-agent needs to run them by bare name.
- Installed into an isolated Bun (`BUN_INSTALL` and `HOME` in a temp directory): `j5` is on the global bin path; `j5 list` run from another directory finds every team; a launch gets as far as its PR lookup.
- **Through a registry** (a throwaway Verdaccio 6.10.5, not GitHub's): `bun publish` needs a `registry=` line in `.npmrc` **as well as** the `//host/:_authToken=` line; with only the token line it fails with "missing authentication". Installing: no scope configured gives a 404 from npmjs.org, a configured scope without the token gives 401, with the token it installs, and `bun update -g` works.
- `j5 setup` from the installed copy with a fresh home directory: installs the skill; a second run changes nothing; `--check` creates nothing; with a recording stand-in `docker`, `--proxy` runs exactly `docker compose --env-file <home>/.config/cagent/.env -f <installed package>/containers/pi-openai-proxy/compose.yaml up -d --wait` and writes an owner-only env file. The token never appears in output.
- The shipped `compose.yaml` parses from the installed package and its build context (`Dockerfile`, `.dockerignore`, `package.json`, `bun.lock`, `patch-usage.ts`, `models.json`) is all there, so the build fallback works.
- **A single compiled executable does not work yet.** `bun build --compile --asset workflows --asset skills …` builds in 0.2 s to a 78 MB binary, but running it fails with `no team manifests found under /workflows`: inside the binary the code's own path is the virtual `/$bunfs/root`, so the "two directories up" root is `/`. Beyond that, docker-agent and Compose read `team.yaml` and `compose.yaml` from the real filesystem (the embedded files would have to be extracted), and the helpers import `zod` and need bundling. `BUN_BE_BUN=1` makes such a binary act as `bun`, which would cover running helpers.

**Not verified:**

- Anything against GitHub's own registry: the SSO authorisation of the token, who can read the package, and that the `registry=` plus token `.npmrc` that `publish-package.yml` writes is accepted by `npm.pkg.github.com`. The first release is the first test.
- Windows and macOS installs. The workflow and `bin` entry rely on Bun generating the `j5` command from the `#!/usr/bin/env bun` line; that is untested on Windows.
- A second machine pulling the proxy image after a team was given Read.
