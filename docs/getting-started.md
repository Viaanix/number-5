# Getting started with number-5

This guide takes you from a fresh computer to your first `j5` command, on **Linux**, **macOS** or **Windows**. Every step has the exact command to type. Do the steps in order, and run each command by itself.

> **How well tested is this?** The Linux commands were run and checked. The macOS and Windows commands come from the tools' own install pages and have **not** been run on those systems. If one of them fails, stop, copy the error message, and ask; do not improvise. [Troubleshooting](#troubleshooting) lists the errors we have actually seen.

## What you will end up with

- `j5`, a command that starts a team of AI agents against one of your git projects. Examples: review a pull request, or take a GitHub issue to a pull request.
- A small program on your computer (the **proxy**, in a Docker container) that lets those agents use **your own Claude subscription**.

## Before you start

You need all of these. Get anything missing first.

- **A GitHub account** that can read the `Viaanix/number-5` repository. Ask an admin to give you **Read** on it. Without that you cannot install the package in Step 4.
- **Your own Claude Pro or Max subscription.** Only Step 6 uses it. Use your own account, never someone else's.
- **Permission to install software** on your computer (an administrator password, probably).
- **A terminal**, opened like this:
  - **Linux:** open the *Terminal* app.
  - **macOS:** press `Cmd + Space`, type `Terminal`, press Enter.
  - **Windows:** press the Windows key, type `PowerShell`, and open **Windows PowerShell** (or *Terminal*). Do **not** use *Command Prompt* or *Git Bash*.

Commands in this guide are in grey boxes. Type or paste the box contents, press Enter, and wait for it to finish before the next one. If a box has `<something in angle brackets>`, replace the whole thing, brackets included, with your own value.

## Step 1: Install the tools

You need five things: Git, the GitHub CLI (`gh`), Docker, the `docker agent` plugin, and Bun. For each, install it, then run the **check** command underneath. If the check does not print a version number, do not move on.

### 1.1 Git

**Linux (Debian, Ubuntu):**

```bash
sudo apt update
sudo apt install -y git unzip
```

(`unzip` is needed for Bun in 1.5.) On other Linux systems use your package manager, for example `sudo dnf install git unzip`.

**macOS:**

```bash
xcode-select --install
```

A window opens; click **Install** and wait. If it says the tools are already installed, that is fine.

**Windows (PowerShell):**

```powershell
winget install --id Git.Git -e --source winget
```

Then **close PowerShell and open it again** so it can find Git.

**Check (all systems):**

```bash
git --version
```

Now tell Git who you are. The agents make commits as you. Use your real name and the email on your GitHub account:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

### 1.2 GitHub CLI (`gh`)

**Linux (Debian, Ubuntu)**, from [GitHub's install page](https://github.com/cli/cli/blob/trunk/docs/install_linux.md). Paste all of it as one block:

```bash
(type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \
	&& sudo mkdir -p -m 755 /etc/apt/keyrings \
	&& out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
	&& cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
	&& sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& sudo mkdir -p -m 755 /etc/apt/sources.list.d \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
	&& sudo apt update \
	&& sudo apt install gh -y
```

For other Linux systems, use the matching section of the same page.

**macOS** (needs [Homebrew](https://brew.sh); if `brew --version` says "command not found", install Homebrew from that page first):

```bash
brew install gh
```

**Windows (PowerShell):**

```powershell
winget install --id GitHub.cli
```

Close and reopen PowerShell afterwards.

**Log in** (all systems):

```bash
gh auth login
```

Answer the questions like this:

1. *Where do you use GitHub?* → **GitHub.com**
2. *Preferred protocol?* → **HTTPS** (simplest)
3. *Authenticate Git with your GitHub credentials?* → **Yes**
4. *How would you like to authenticate?* → **Login with a web browser**

Copy the one-time code it shows, press Enter, paste the code into the browser page, and approve. If GitHub asks you to **authorize for Viaanix** (single sign-on), do that too.

**Check:**

```bash
gh auth status
```

It should say you are logged in to `github.com`.

### 1.3 Docker

Docker runs the proxy in Step 6. The teams use it too.

**macOS and Windows:** install **Docker Desktop** from <https://www.docker.com/products/docker-desktop/>. On Windows it will ask to enable *WSL 2*; accept, and restart the computer if it asks. **Then open the Docker Desktop app and wait until it says the engine is running.** Docker commands fail while the app is closed.

**Linux:** install Docker Engine by following the page for your system at <https://docs.docker.com/engine/install/> (for Ubuntu: <https://docs.docker.com/engine/install/ubuntu/>). Then let your user use it without `sudo`:

```bash
sudo usermod -aG docker $USER
```

**Log out of your computer and log back in** (closing the terminal is not enough). Members of the `docker` group effectively have administrator access to the machine, which is normal for Docker but worth knowing.

**Check (all systems):**

```bash
docker version
```

You should see both a **Client** and a **Server** section. If the Server part says `permission denied`, you have not yet logged out and in (Linux). If it says it cannot connect to the daemon, Docker is not running: open Docker Desktop, or on Linux run `sudo systemctl start docker`.

### 1.4 The `docker agent` plugin

This is what actually runs the agents. First see whether you already have it. **Docker Desktop 4.63 or newer includes it.**

```bash
docker agent version
```

If that prints `docker agent version v1.…`, skip to 1.5. It is fine if the version differs a little from `v1.145.0`, which is what number-5 was tested with; `j5 setup` will warn you, not stop you.

If it says `docker: 'agent' is not a docker command`, install the tested version:

**Linux and macOS:**

```bash
mkdir -p ~/.docker/cli-plugins
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m); case "$ARCH" in x86_64) ARCH=amd64;; aarch64|arm64) ARCH=arm64;; esac
curl -fL "https://github.com/docker/docker-agent/releases/download/v1.145.0/docker-agent-${OS}-${ARCH}" -o ~/.docker/cli-plugins/docker-agent
chmod +x ~/.docker/cli-plugins/docker-agent
docker agent version
```

**Windows (PowerShell):**

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.docker\cli-plugins" | Out-Null
Invoke-WebRequest "https://github.com/docker/docker-agent/releases/download/v1.145.0/docker-agent-windows-amd64.exe" -OutFile "$env:USERPROFILE\.docker\cli-plugins\docker-agent.exe"
docker agent version
```

On a Windows ARM computer, use `docker-agent-windows-arm64.exe` in both places instead.

### 1.5 Bun

Bun is the runtime `j5` runs on. You need **version 1.4.2 or newer**.

**Linux and macOS:**

```bash
curl -fsSL https://bun.com/install | bash
```

**Windows (PowerShell):**

```powershell
powershell -c "irm bun.sh/install.ps1|iex"
```

**Close the terminal and open a new one**, then check:

```bash
bun --version
```

It must print `1.4.2` or higher. If it prints something lower, run `bun upgrade` and check again. If it says `command not found`, see [`j5` or `bun`: command not found](#j5-or-bun-command-not-found).

## Step 2: Make your access token

The package lives in your organisation's private registry, and a **token** is your password for it. You make it once.

1. Log in to GitHub in your browser, as the account that has access to `Viaanix/number-5`.
2. Open <https://github.com/settings/tokens/new?scopes=read:packages&description=number-5>. (Or: your profile picture → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)**.)
3. It must be a **classic** token. Give it a name such as `number-5 install`, choose an expiry, and tick **only `read:packages`**. Do not tick anything else.
4. Click **Generate token** and **copy it now**. GitHub never shows it again.
5. Back on the token list, click **Configure SSO** next to your new token, then **Authorize** next to **Viaanix**. If you do not see that button, your organisation does not require it; skip this.

**Treat the token like a password.** Never paste it into a chat, a ticket, a commit, or a screenshot.

## Step 3: Tell Bun where to find the package

Two small settings: the token goes into an *environment variable*, and one line in a Bun settings file says "packages starting with `@viaanix` come from GitHub".

### 3.1 Save the token in an environment variable

**Linux** (most Linux terminals use bash; check with `echo $SHELL`, which prints `/bin/bash`):

```bash
nano ~/.bashrc
```

Go to the very end of the file and add this line, with your real token after the `=`:

```bash
export NUMBER5_REGISTRY_TOKEN=<paste your token here>
```

Save with `Ctrl+O`, press Enter, and quit with `Ctrl+X`. If `echo $SHELL` printed `/bin/zsh`, edit `~/.zshrc` instead.

**macOS** (the default shell is zsh):

```bash
touch ~/.zshrc
open -e ~/.zshrc
```

Add this line at the end, with your real token after the `=`, then save and close:

```bash
export NUMBER5_REGISTRY_TOKEN=<paste your token here>
```

**Windows (PowerShell).** This asks you to paste the token, so it does not stay in your command history:

```powershell
[Environment]::SetEnvironmentVariable("NUMBER5_REGISTRY_TOKEN", (Read-Host "Paste the token and press Enter"), "User")
```

**Close the terminal and open a new one** (on every system), then check that it is set. These commands do not print the token:

```bash
test -n "$NUMBER5_REGISTRY_TOKEN" && echo "token is set" || echo "token is MISSING"
```

On Windows PowerShell:

```powershell
if ($env:NUMBER5_REGISTRY_TOKEN) { "token is set" } else { "token is MISSING" }
```

### 3.2 Add the registry setting

**Linux and macOS** (copy the whole box; the quotes around `EOF` matter):

```bash
cat >> ~/.bunfig.toml <<'EOF'
[install.scopes]
"@viaanix" = { token = "$NUMBER5_REGISTRY_TOKEN", url = "https://npm.pkg.github.com/" }
EOF
```

**Windows (PowerShell):**

```powershell
Add-Content "$env:USERPROFILE\.bunfig.toml" @'
[install.scopes]
"@viaanix" = { token = "$NUMBER5_REGISTRY_TOKEN", url = "https://npm.pkg.github.com/" }
'@
```

Note the file holds the *name* `$NUMBER5_REGISTRY_TOKEN`, not the token itself. That is correct and means the file is safe to look at.

If you already had a `~/.bunfig.toml` with its own `[install.scopes]` section, do not add a second one; add only the `"@viaanix" = …` line under the existing section.

## Step 4: Install number-5

```bash
bun add -g @viaanix/number-5
```

Then check:

```bash
j5 --version
```

You should see `@viaanix/number-5 0.1.0` (or a newer number). If you see an error, find it in [Troubleshooting](#troubleshooting).

## Step 5: Check your computer

```bash
j5 setup
```

This looks at your tools and installs the agent "skills" the teams read. Each line starts with a status word:

| Word | Meaning |
|---|---|
| `ok` | Fine |
| `changed` | It did something for you (for example, installed a skill) |
| `warning` | Worth reading, not blocking. For example: `gh is not logged in` (do `gh auth login`) |
| `missing` | You must fix this. The line says what and how |

Fix every `missing` line, then run `j5 setup` again until none are left. To look without changing anything, run `j5 setup --check`.

## Step 6: Start the proxy and log in to Claude

The agents talk to Claude through the proxy. This one command creates a local password for it, starts it, and opens a login:

```bash
j5 setup --proxy --login
```

What happens:

1. It creates `PI_PROXY_AUTH_TOKEN` in `~/.config/cagent/.env`. That is a local password between your tools and the proxy, **not** your Claude password. You never type it.
2. It starts the proxy in Docker. The **first time takes a few minutes**. You may see `unauthorized` from `ghcr.io`; that is fine, it then builds the same image on your computer.
3. When the proxy has no Claude login yet, **Pi** opens in your terminal. Do exactly this:
   - Type `/login` and press Enter.
   - Choose **Use a subscription**, then **Anthropic (Claude Pro/Max)**.
   - Open the link it prints in your browser, sign in with **your own** Claude account, and approve.
   - Come back to the terminal. When it says you are logged in, press `Ctrl+D` to leave Pi. (Pi's own footer lists `ctrl+c/ctrl+d clear/exit`; if `Ctrl+D` does nothing, press `Ctrl+C` once to clear the input line and then `Ctrl+D`.)
4. `j5` then counts the models. You want a line like `ok  proxy on port 4141 serves 25 models`.

You only do this once per computer. To check later:

```bash
j5 setup --check --proxy
```

## Step 7: Your first run

You have to be in a git project, or name one with `--project`. Use a **practice repository** you are allowed to experiment in, not a production one.

Find your project folder first. This example uses `~/code/practice-repo`; replace it with yours:

```bash
cd ~/code/practice-repo
```

(On Windows PowerShell this looks like `cd C:\Users\you\code\practice-repo`.)

### 7.1 Look around (changes nothing)

```bash
j5 list
```

This lists the teams and what each one needs. You will see `issue-team` (take a GitHub issue to a pull request), `pr-reviewer` (review a pull request), and `test-quality`.

### 7.2 See what a command would do, without running it

`--print` shows the exact command and runs nothing. Use a real pull request number from your practice repo instead of `1`:

```bash
j5 pr-reviewer review --pr 1 --print
```

### 7.3 Review a pull request

```bash
j5 pr-reviewer review --pr 1
```

- It makes a **separate copy** of the project next to yours, called something like `practice-repo-pr-1-detached`. Your own files are not touched.
- It reads the change and writes a review report.
- **Before it posts anything**, a dialog shows you the full comment and asks permission. It posts **one comment on the pull request, as your GitHub account.** Read it first. Answer *no* if you are not sure.

### 7.4 Take an issue to a pull request

```bash
j5 issue-team work-issue --issue 1
```

This one **writes code, pushes a branch, and opens a pull request** in the project. Only run it on a repository where that is okay. It stops and asks you when the issue is unclear, and it opens a draft pull request when its own checks do not pass.

### 7.5 Tidy up the extra copies

Each run uses its own copy (a git *worktree*) beside your project. List them, and remove one you no longer need:

```bash
git worktree list
git worktree remove ../practice-repo-pr-1-detached
```

## Everyday use

- Start the interactive mode, which asks you each choice: `j5`
- See every option: `j5 --help`
- Update: `bun update -g @viaanix/number-5`, then **`j5 setup`** again. Update between runs; do not update while an agent is running.
- Uninstall: `bun remove -g @viaanix/number-5`. To also remove the proxy and the Claude login it holds: `docker rm -f j5-pi-openai-proxy-proxy-1` then `docker volume rm j5-pi-openai-proxy_pi-auth`.

## Troubleshooting

Find the start of your error message in the left column.

| What you see | What it means and what to do |
|---|---|
| `E404 … registry.npmjs.org/@viaanix%2fnumber-5` | Bun is asking npmjs.org instead of GitHub: Step 3.2 is missing or in the wrong file. Check `cat ~/.bunfig.toml` (Windows: `Get-Content $env:USERPROFILE\.bunfig.toml`). |
| `401` from `npm.pkg.github.com` | The token is missing, wrong, expired, or not authorised for Viaanix. Check Step 3.1's "token is set" test, and Step 2.5 (Configure SSO). Open a **new** terminal after changing it. |
| `404` from `npm.pkg.github.com` | Your GitHub account cannot see the package. Ask an admin for **Read** on `Viaanix/number-5`. |
| <a id="j5-or-bun-command-not-found"></a>`j5: command not found` or `bun: command not found` | The terminal cannot find Bun's folder. Open a **new** terminal first. Still failing: Linux/macOS, add `export PATH="$HOME/.bun/bin:$PATH"` to `~/.bashrc` (bash) or `~/.zshrc` (zsh) and open a new terminal. Windows, in PowerShell run `[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";$env:USERPROFILE\.bun\bin", "User")`, then open a new PowerShell. |
| `permission denied … /var/run/docker.sock` (Linux) | Docker is running but your user may not use it. Run `sudo usermod -aG docker $USER`, **log out and back in**, then try again. |
| `Cannot connect to the Docker daemon`, or `docker: error during connect` | Docker is not running. macOS/Windows: open Docker Desktop and wait for "Engine running". Linux: `sudo systemctl start docker`. |
| `docker: 'agent' is not a docker command` | Step 1.4 is not done. |
| `The following environment variables must be set: PI_PROXY_AUTH_TOKEN` followed by "Run the interactive setup now to configure a model?" | Answer **n** (or press `Ctrl+C`), then run `j5 setup --proxy`. Do not use the interactive model setup: number-5 already knows which model service to use. |
| `warning  proxy on port 4141 is up but has no Claude login yet` | Run `j5 setup --login`. |
| `warning  proxy … refused the token (HTTP 401)` | The running proxy was started with a different token. Run `j5 setup --proxy` between runs so it restarts with the one `j5` uses. |
| `PI_PROXY_AUTH_TOKEN is required` (printed by the container, exit 64) | You started the proxy image by hand without its token. Use `j5 setup --proxy` instead. |
| `warning  gh is not logged in` | Run `gh auth login` (Step 1.2). |
| `warning  docker-agent v… the teams were tested with v1.145.0` | A different `docker agent` version. Usually still works. To match exactly, redo Step 1.4's download. |
| `skill … exists and was not installed by number-5 … left alone` | Another skill with the same name is already there. `j5` will not overwrite it. Safe to ignore unless a team complains. |

If it is none of these, copy the **whole** error text and the command you ran, and ask. Never include your token.

## Words you will see

- **Pull request (PR):** a proposed change to a project, on GitHub, waiting for review.
- **Issue:** a task or bug report on GitHub.
- **Worktree:** a second working copy of the same git project in another folder. `j5` uses one per run so your own files are never touched.
- **Proxy:** the small program in Docker that carries the agents' requests to Claude using your login.
- **Token:** a long secret string that works like a password. There are two here: the GitHub token (Step 2, to download the package) and the proxy token (Step 6, created for you).
- **Registry:** a server that stores installable packages. Ours is GitHub Packages.
- **Skill:** a folder of instructions the agents read. `j5 setup` copies them to `~/.agents/skills`.

## What was and was not checked

**Seen on real machines (2026-10-15):** the `E404` from npmjs.org, `permission denied` on the Docker socket, `PI_PROXY_AUTH_TOKEN must be set` with the interactive-setup prompt, the `unauthorized` pull from `ghcr.io` followed by a local build, the `no Claude login yet` warning, and the `gh is not logged in` warning.

**Run on Linux, but not on a real second machine:** the docker-agent download command; `bun add -g @viaanix/number-5`, `j5 --version`, `j5 list` and `j5 setup` from an installed copy; the `401` (against a stand-in registry, not GitHub's); and the container's `PI_PROXY_AUTH_TOKEN is required` exit.

**Not checked:** every macOS and Windows command (taken from the tools' own pages); a `401` or `404` from GitHub's own registry; the "cannot connect to the Docker daemon" wording; the `refused the token` warning on a real proxy; the exact wording of the `gh auth login` prompts; and the Pi login screens on a fresh account.

For maintainers and how releases work, see [packaging.md](packaging.md).
