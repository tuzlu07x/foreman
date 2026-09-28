# Install Foreman

How to install Foreman on macOS, Linux and Windows (WSL2), run it for the first time, check it, and remove it again.

Foreman is published on npm as [`foreman-agent`](https://www.npmjs.com/package/foreman-agent). It needs **Node.js 22.12 or later**. Node 20 is end-of-life and not supported.

---

## TL;DR cheat sheet

| Step | macOS | Linux | Windows |
| --- | --- | --- | --- |
| 1. Prereqs | Node 22.12+ (the installer can set it up), `chafa` (optional) | same | WSL2 with Ubuntu, then as Linux |
| 2. Install | `curl -fsSL https://raw.githubusercontent.com/tuzlu07x/foreman/main/install.sh \| bash` or `npm install -g foreman-agent` | same | same, inside WSL2 |
| 3. First run | `foreman start`, then the setup wizard | same | same |
| 4. Verify | `foreman doctor`: exit code 0 or 1 (warnings only) | same | same |

> **OpenClaw needs a newer Node than Foreman.** Since v2026.9.3 OpenClaw requires Node `>=24.16.0 <25 || >=26.1.0`. If the `node` on your PATH is older (say 22.x), Foreman won't run `npm install -g openclaw`: the wizard and `foreman agent add` print the requirement and OpenClaw's upstream installer instead, and set up your other agents as usual. Either switch to Node 24.16+ or 26.1+ (e.g. `nvm install 24`) and add OpenClaw again, or run the upstream installer yourself, which provisions a supported Node when it's missing:
> ```bash
> curl -fsSL https://openclaw.ai/install.sh | bash
> ```
> Foreman never runs that script for you. `foreman doctor` warns while OpenClaw is registered or installed on an older Node.

---

## Supported platforms

Foreman's SQLite driver, better-sqlite3, ships prebuilt native binaries inside its npm package. Nothing is compiled or downloaded at install time, so no C/C++ toolchain or Python is needed. It also means Foreman runs only where a prebuilt binary exists:

| OS | Architectures | npm package | Standalone binary |
| --- | --- | --- | --- |
| macOS | arm64 (Apple silicon), x64 | yes | yes |
| Linux, glibc (Ubuntu, Debian, Fedora, …) | x64, arm64 | yes | yes |
| Linux, musl (Alpine) | x64, arm64 | yes | no: it is built on the glibc Node.js |
| Windows | x64, arm64 | inside WSL2 | inside WSL2 (Linux binary) |

On any other platform or architecture (FreeBSD, 32-bit ARM, …) `npm install` still succeeds, but Foreman can't open its database and exits with an error.

---

## Install

Pick one. All of them put the same `foreman` command on your PATH.

### The install script (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/tuzlu07x/foreman/main/install.sh | bash
```

The script reuses the `node` on your PATH when it is Node 22 or 24. Otherwise it installs nvm and Node 22 LTS through it (no compiler or Python needed), then runs `npm install -g foreman-agent`. Options:

| Variable / flag | Effect |
| --- | --- |
| `FOREMAN_VERSION=<version>` | Install that release instead of the latest |
| `FOREMAN_INSTALL_PREFIX=<dir>` | Use a non-default npm prefix |
| `FOREMAN_SKIP_NVM=1` | Never bootstrap nvm; fail if no supported Node is found |
| `FOREMAN_REUSE_ANY_NODE=1` | Reuse a Node >= 22 outside the tested 22 / 24 lines |
| `--uninstall` | Remove the global package (Foreman's data is left in place) |

Flags go after `bash -s --`, for example `curl -fsSL …/install.sh | bash -s -- --uninstall`.

If the script installed Node through nvm, open a new shell (or run `. "$HOME/.nvm/nvm.sh"`) before running `foreman`.

### npm

With Node 22.12+ already installed:

```bash
npm install -g foreman-agent
```

### Homebrew (macOS, Linuxbrew)

```bash
brew tap tuzlu07x/foreman && brew install foreman-agent
```

### From source (contributors)

```bash
git clone https://github.com/tuzlu07x/foreman.git
cd foreman
npm ci
npm run build
npm install -g .
```

### Check it

```bash
foreman --version       # prints the installed version
which foreman
```

---

## Standalone binary (no Node.js)

Every GitHub release has a single-file `foreman` for `darwin-arm64`, `darwin-x64`, `linux-x64` and `linux-arm64`, plus a `SHA256SUMS` file. Each is built and smoke-tested on a machine of its own platform and architecture.

```bash
target=linux-x64   # or linux-arm64, darwin-arm64, darwin-x64
base=https://github.com/tuzlu07x/foreman/releases/latest/download
curl -fsSLO "$base/foreman-$target" && curl -fsSLO "$base/SHA256SUMS"
grep " foreman-$target\$" SHA256SUMS | shasum -a 256 -c -   # Linux without shasum: sha256sum -c -
chmod +x "foreman-$target" && sudo mv "foreman-$target" /usr/local/bin/foreman
foreman --version
```

How it differs from the npm package:

- **It's big: about 130 MB.** It's the official Node.js 22 binary with Foreman and its dependencies built in, as a [Node.js single executable application](https://nodejs.org/api/single-executable-applications.html). Nothing else is needed on the machine.
- **It writes a few files on first start.** The database migrations, the bundled registry, the mascot art and the SQLite native addon go to `runtime/<version>-<hash>/` in Foreman's cache dir (`~/Library/Caches/foreman/` on macOS, `~/.cache/foreman/` on Linux, `$FOREMAN_HOME/cache/` if set). That directory is owner-only, and every file is checked against its SHA-256 on each start and rewritten if it changed. Old versions' directories can be deleted.
- **There's no `foreman-hook`.** Agent hooks call `foreman hook <agent>` instead, which does the same thing.
- **Updates are manual.** Download the new release's binary over the old one.
- **macOS:** a binary downloaded with a browser is quarantined by Gatekeeper; `curl` doesn't do that. If macOS refuses to open it, run `xattr -d com.apple.quarantine /usr/local/bin/foreman`. The binary is ad-hoc signed, not notarized.

To uninstall, delete the binary and the `runtime/` directory in the cache dir, then remove Foreman's state as in [Uninstall](#uninstall).

---

## Platform notes

### macOS

```bash
brew install node       # or nvm; you need Node 22.12+
brew install chafa      # optional: the higher-fidelity boot mascot
node --version          # v22.12 or later
```

Then use any of the [install](#install) options.

Foreman keeps its files in:

- Config and state: `~/Library/Application Support/foreman/` (`identity.key`, `secrets.key`, `policy.yaml`, `SOUL.md`, `foreman.db`, `setup-state.json`, …)
- Cache: `~/Library/Caches/foreman/`

Gotchas:

- **`Application Support` has a space in the path.** When wiping state, quote it (`"$HOME/Library/Application Support/foreman"`), or zsh's `nomatch` aborts the whole `rm`.
- **`/bin/false` doesn't exist on macOS.** Use `/usr/bin/false` if a script hard-codes it.

### Linux (Ubuntu 22.04+, Debian and similar)

The install script sets up Node for you. To do it yourself with nvm:

```bash
curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh" | bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install 22
node --version          # v22.12 or later

sudo apt install chafa  # optional: the higher-fidelity boot mascot
```

Foreman follows the XDG layout:

- Config: `~/.config/foreman/` (`identity.key`, `secrets.key`, `policy.yaml`, `SOUL.md`, `setup-state.json`, …)
- State: `~/.local/state/foreman/` (`foreman.db`)
- Cache: `~/.cache/foreman/`

`$XDG_CONFIG_HOME`, `$XDG_STATE_HOME` and `$XDG_CACHE_HOME` are honoured if set. If `FOREMAN_HOME` is set, everything goes into that one directory instead (cache in `$FOREMAN_HOME/cache/`). `foreman doctor` prints the paths in use.

Gotchas:

- **nvm doesn't load in every shell.** If a fresh SSH session says `foreman: command not found`, run `. "$HOME/.nvm/nvm.sh"` first.
- **`chafa`** is packaged as `chafa` on Debian and Ubuntu; build it from source on older distros.
- **The Hermes gateway runs as a systemd user service** (`hermes gateway install` creates `~/.config/systemd/user/hermes-gateway.service`). Run `loginctl enable-linger $USER` so it survives logout.

### Windows

Foreman runs **inside WSL2**. Native Windows isn't supported: the Ink TUI's raw-mode handling expects a Unix terminal.

From an admin PowerShell:

```powershell
wsl --install -d Ubuntu-22.04
```

Reboot, open the Ubuntu app to finish the user setup, then follow the Linux steps inside it. [`windows-wsl2.md`](windows-wsl2.md) has the full walkthrough and the WSL-specific quirks.

- **File system performance** is best inside the WSL filesystem (`~/`), not the Windows mount (`/mnt/c/...`). Keep Foreman's state there.
- **Telegram polling needs outbound TCP.** WSL uses the host's network; if a corporate VPN blocks api.telegram.org, the Hermes gateway retries in a loop.

---

## First run

```bash
foreman start
```

On a fresh machine Foreman says it isn't configured yet and offers:

```
  [Enter] Run setup now
  [s]     Skip and launch with defaults
  [q]     Quit
```

Enter creates Foreman's home (identity key, default `policy.yaml`, `SOUL.md`, database) and starts the setup wizard. You can also run the wizard on its own with `foreman setup`. The wizard has five steps:

1. **Welcome.** Enter starts setup, `q` quits. You can quit later with Ctrl-C (except while agents are installing) and pick up where you left off with `foreman setup --resume`.
2. **Step 1 of 5: LLM Providers.** Space toggles the providers you have (Anthropic, OpenAI, Google Gemini, local Ollama, a custom OpenAI-compatible endpoint), Enter confirms. For Anthropic and OpenAI you can sign in with your Claude or ChatGPT subscription instead of pasting a key. Otherwise paste each key at its prompt; a help URL is shown. You can confirm with nothing selected and add providers later.
3. **Step 2 of 5: Foreman's brain.** Pick the LLM Foreman itself uses to check risky calls and write summaries: Anthropic, OpenAI or Google Gemini (rows you haven't configured in Step 1 are greyed out), or **Skip: heuristics only**. Local Ollama and OpenAI-compatible brains are listed as "coming in v0.2".
4. **Step 3 of 5: Agents.** Space toggles the agents to install; Hermes and Claude Code are pre-checked when their LLM is configured, and agents whose LLM isn't configured are hidden. For each agent you pick its LLM, route and model and an optional responsibility note, then confirm.
5. **Step 4 of 5: Services** (optional). Tokens for Telegram, Discord, Slack, GitHub, Atlassian, … If two chat agents share a channel, you pick which one is primary.
6. **Step 5 of 5: Install + Verify.** First the keys the chosen routes still need (paste or skip), then Foreman installs, configures and registers each agent.
7. **Done.** A summary, then:

   | Key | |
   | --- | --- |
   | `Enter` | Under `foreman start`: launch the TUI. Under `foreman setup`: finish and exit (start Foreman later with `foreman start`). If a sign-in is required, it runs first. |
   | `y` | Run every OAuth sign-in step now, including optional ones (shown only when there are any) |
   | `d` | Run `foreman doctor` |
   | `p` | Review the policy file |
   | `l` | Show the install log |
   | `q` | Exit without launching anything or running sign-ins |

The dashboard shows your agents, the activity feed and today's numbers. The bottom line lists the keys for the page you're on, and `?` on the Home page shows all of them. See [`tui.md`](tui.md).

`foreman start` is also what answers approvals: keep it running while your agents work. See [How approvals work](tui.md#how-approvals-work).

To start with the default policy only, press `s` at that prompt (Foreman remembers the choice and doesn't offer the wizard again) or run `foreman start --skip-setup` for a single run. `foreman setup` opens the wizard whenever you want it.

---

## Verify

In another shell:

```bash
foreman doctor          # exit 1 with a few warnings is normal on a fresh machine
foreman agent list      # the agents you picked
foreman secrets list    # the keys you entered
```

On a fresh machine `doctor` warns that no agents are registered yet, that agent CLIs you haven't installed (Hermes, OpenClaw, ZeroClaw) aren't on your PATH, and that the optional `chafa` is missing. Exit code 2 is a real failure. See [`doctor.md`](doctor.md).

---

## After the install: optional follow-ups

### Add another agent

The wizard already installed and registered whatever you picked. Add another one later:

<!-- pending: #656/#657 -->
```bash
foreman registry list                     # the agents Foreman knows
foreman agent add openclaw --auto-install # install it if missing, then register it
foreman agent list
```

OpenClaw needs Node `>=24.16.0 <25 || >=26.1.0` on your PATH (see the note under the [cheat sheet](#tldr-cheat-sheet)). On an older Node, `--auto-install` stops with the requirement and the upstream installer command instead of installing.

### Replace a key

```bash
foreman secrets rotate anthropic-key            # prompts for the new value
foreman secrets show anthropic-key --reveal
```

### Foreman's persona

```bash
foreman identity show        # the SOUL.md every agent inherits
foreman identity edit        # opens $EDITOR, then pushes it to the agents
foreman identity push        # re-push after editing the file by hand
```

### Shell completion

```bash
foreman completion zsh > ~/.zsh/completions/_foreman
# or
foreman completion bash > /etc/bash_completion.d/foreman
```

See [`completion.md`](completion.md).

### Run the doctor whenever something feels off

```bash
foreman doctor           # exit 0 (all ok), 1 (warnings only), 2 (failures)
foreman doctor --json    # the same checks, for scripts
```

---

## Uninstall

Do it in this order: the first steps need the `foreman` command, which step 5 removes.

```bash
# 1. Remove the PreToolUse hook Foreman added to Claude Code (if you installed it).
foreman agent hook uninstall claude-code

# 2. Note where Foreman keeps its files (the foreman_home and paths lines).
foreman doctor

# 3. (optional) Undo the Foreman SOUL injection in each agent's identity file.
#    Foreman kept a copy of any file it replaced as <file>.pre-foreman.bak.
#    Restore it instead of deleting the file (Codex's AGENTS.md holds your
#    own global instructions). Only delete files Foreman created itself.
for f in ~/.hermes/SOUL.md ~/.codex/AGENTS.md; do
  [ -f "$f.pre-foreman.bak" ] && mv "$f.pre-foreman.bak" "$f"
done

# 4. Remove the `foreman` MCP server entry from each agent's config.
#    `foreman agent remove` doesn't do this; see docs/agent-lifecycle.md
#    for where each agent keeps it (e.g. mcpServers.foreman in ~/.claude.json).

# 5. Remove the package (whichever way you installed it).
npm uninstall -g foreman-agent
# or: curl -fsSL https://raw.githubusercontent.com/tuzlu07x/foreman/main/install.sh | bash -s -- --uninstall
# or: brew uninstall foreman-agent

# 6. Remove Foreman's home. Back it up first if you want to keep the audit log.
# macOS
rm -rf "$HOME/Library/Application Support/foreman" "$HOME/Library/Caches/foreman"
# Linux / WSL (or the FOREMAN_HOME directory, if you set one)
rm -rf ~/.config/foreman ~/.local/state/foreman ~/.cache/foreman
```

Keys Foreman projected into an agent's own files (for example `~/.hermes/.env`, see [Secret projection](agent-lifecycle.md#secret-projection-222--223)) stay there; remove them if you no longer want them.

---

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| `foreman: command not found` after install | Open a new terminal (or `hash -r`). If you installed through nvm, run `. "$HOME/.nvm/nvm.sh"`. Otherwise check that `$(npm prefix -g)/bin` is on your PATH. |
| npm warns `EBADENGINE`, or `foreman doctor` fails `node_version` | Your Node is older than Foreman needs (22.12+). Install Node 22 LTS (`nvm install 22`) and reinstall Foreman. |
| `foreman start` skips the wizard | Foreman's home already exists with registered agents, or you skipped setup before. Run the wizard with `foreman setup --resume` or `foreman setup --reset`, or wipe the home (see [Uninstall](#uninstall)). |
| Wizard's Step 1 doesn't ask for any key | Nothing was selected when you pressed Enter. Press Esc to go back to the selection, Space on each provider, then Enter. |
| Wizard or `foreman agent add` says "OpenClaw needs Node >=24.16.0 <25 \|\| >=26.1.0" | The `node` on your PATH is too old for OpenClaw. Switch to Node 24.16+ or 26.1+ (`nvm install 24`) and add it again, or run `curl -fsSL https://openclaw.ai/install.sh \| bash` yourself. |
| An agent toggle didn't take in the wizard | Check the `Checked:` line above the list and the confirm screen (`Selected: …`). If your pick isn't there, Esc back, Space again, Enter. |
| Telegram polling fails on Linux | Check that outbound TCP to `api.telegram.org` isn't blocked. The gateway prints `httpx.ConnectError: All connection attempts failed` in journalctl. |
| Bot still says "Hermes Agent" instead of "Foreman" after registration | Run `hermes sessions prune --older-than 0 --yes`, then restart the gateway. The session prompt was cached before the SOUL write. |
| `foreman doctor` exits 1 on a fresh machine | Normal: warnings only (no agents yet, agent CLIs not installed, `chafa` missing). Exit 2 is a real failure (missing identity key, corrupt database, malformed `policy.yaml`). |

Open an issue at `github.com/tuzlu07x/foreman/issues` if something here doesn't match what you see.
