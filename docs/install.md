# Foreman v0.1.0 — Install + first-run guide

Step-by-step recipes for macOS, Linux, and Windows. Pick the section that matches your machine.

> **Pre-release note**: As of v0.1.0 the `foreman-agent` npm package is **not yet published** and the GitHub repo is **private**. The documented `curl … | bash` shortcut therefore 404s today. Until both ship, follow the **from-source** path below — same outcome, two extra commands.

---

## TL;DR cheat sheet

| Step | macOS | Linux | Windows |
| --- | --- | --- | --- |
| 1. Prereqs | Node 20+, git, `chafa` (optional) | Node 20+, git, `chafa` (optional) | WSL2 Ubuntu — see below |
| 2. Get the code | `git clone … && cd foreman` | `git clone … && cd foreman` | inside WSL2 |
| 3. Install | `npm ci && npm run build && npm install -g .` | same | same (inside WSL2) |
| 4. First run | `foreman start` → wizard auto-launches | same | same |
| 5. Verify | `foreman doctor` → 12+ ok, 1–2 warn | same | same |

After release-day (`npm publish` + GH release + repo public) the entire install becomes one line:
```
curl -fsSL https://raw.githubusercontent.com/tuzlu07x/foreman/main/install.sh | bash
```

---

## macOS

### 1. Prereqs
```bash
# Node 20+ — Homebrew or nvm both fine
brew install node

# Optional: chafa for the higher-fidelity boot mascot
brew install chafa

# Verify
node --version          # v20.x or v22.x
git --version
```

### 2. Get + build Foreman
```bash
git clone git@github.com:tuzlu07x/foreman.git ~/Projects/foreman
cd ~/Projects/foreman
npm ci
npm run build
npm install -g .

# Verify
foreman --version       # 0.1.0
which foreman           # /opt/homebrew/bin/foreman
```

### 3. First run
```bash
foreman start
```

The wizard auto-launches because the foreman home doesn't exist yet. Walk through:

1. **Welcome** → `y` to continue.
2. **Step 1 / 4 — API keys** — three keys are pre-checked (`anthropic-key`, `openai-key`, `telegram-bot-token`). Toggle off any you don't have today with Space; Enter confirms.
3. The wizard then prompts for each selected key's value with a help URL (e.g. `Get yours at: https://console.anthropic.com/settings/keys`). Paste; Enter.
4. **Step 2 / 4 — Agents** — `hermes` + `claude-code` are pre-checked. Space to toggle `openclaw` / `codex` / `zeroclaw` / `generic-mcp` if you want them, Enter confirms.
5. **Step 3 / 4 — Install + configure** — Foreman prints `Selected agents: …` and `Will install: …`, then runs the install / config-inject / Foreman-identity-write for each agent.
6. **Step 4 / 4 — Policy** — `n` to skip the editor (defaults are sensible) or `y` to review.
7. **Done** — the TUI mounts.

The dashboard shows three panels (Agents · Activity · Today) and the status bar lists every hotkey:
```
[?] help · [a] agents · [c] chat · [g] settings · [k] keys · [l] logs · [p] policy · [s] sessions · [q] quit
```

### 4. Verify
In another shell:
```bash
foreman doctor          # 12 ok · 1–2 warnings, exit code 1 is normal on a fresh box
foreman agent list      # the agents you picked
foreman secrets list    # the keys you entered, last-accessed "never"
```

### Filesystem layout (macOS)
- Config + state: `~/Library/Application Support/foreman/`
  - `identity.key`, `secrets.key`, `policy.yaml`, `SOUL.md`, `foreman.db`, `setup-state.json`
- Cache: `~/Library/Caches/foreman/`

### Common macOS gotchas
- **`Application Support` has a space in the path.** When wiping state, use `"$HOME/Library/Application Support/foreman"` (quoted) or zsh's `nomatch` will abort the whole `rm`.
- **`/bin/false` doesn't exist on macOS** — use `/usr/bin/false` if a script hard-codes it.

---

## Linux (Ubuntu 22.04+ / Debian / similar)

### 1. Prereqs
```bash
# Node 20+ — nvm is the path of least resistance
curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh" | bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install 20

# Optional, for the boot mascot
sudo apt install chafa

# Verify
node --version
git --version
```

### 2. Get + build Foreman
Same as macOS:
```bash
git clone git@github.com:tuzlu07x/foreman.git ~/Projects/foreman
cd ~/Projects/foreman
npm ci
npm run build
npm install -g .

foreman --version       # 0.1.0
which foreman           # ~/.nvm/versions/node/v20.x/bin/foreman
```

### 3. First run
```bash
foreman start
```

Same wizard flow as macOS.

### 4. Verify
```bash
foreman doctor
foreman agent list
foreman secrets list
```

### Filesystem layout (Linux — XDG)
- Config: `~/.config/foreman/` — `identity.key`, `secrets.key`, `policy.yaml`, `SOUL.md`
- State: `~/.local/state/foreman/foreman.db`
- Cache: `~/.cache/foreman/`

`$XDG_CONFIG_HOME` / `$XDG_STATE_HOME` / `$XDG_CACHE_HOME` are honoured if set.

### Common Linux gotchas
- **nvm doesn't auto-source in every shell.** If you open a fresh ssh session and `foreman` says "command not found", `. "$HOME/.nvm/nvm.sh"` first.
- **`chafa` package name** is `chafa` on Debian / Ubuntu; build from source on older distros.
- **Systemd user-mode** required for the Hermes gateway path (`hermes gateway install` creates `~/.config/systemd/user/hermes-gateway.service`). Enable with `loginctl enable-linger $USER` so it survives logout.

---

## Windows

Foreman runs **inside WSL2** today. Native Windows support is on the roadmap but the Ink TUI's raw-mode handling expects a Unix terminal.

### 1. Install WSL2
From an admin PowerShell:
```powershell
wsl --install -d Ubuntu-22.04
```
Reboot, then open the Ubuntu app to finish user setup.

### 2. Inside WSL2 — same as Linux
```bash
# Node 20+
curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh" | bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install 20

# Optional
sudo apt install chafa

# Foreman
git clone git@github.com:tuzlu07x/foreman.git ~/Projects/foreman
cd ~/Projects/foreman
npm ci
npm run build
npm install -g .

foreman --version
foreman start
```

### Filesystem layout (Windows native — for when WSL isn't in the picture)
- Config + state: `%APPDATA%\foreman\` (typically `C:\Users\<you>\AppData\Roaming\foreman\`)
- Cache: `%LOCALAPPDATA%\foreman\Cache\`

Foreman resolves these paths correctly, but the TUI's Ink raw-mode currently expects a Unix-style TTY — see [`docs/windows-wsl2.md`](windows-wsl2.md) for the deeper notes.

### Common WSL gotchas
- **File system performance** is best inside the WSL filesystem (`~/`), not the Windows mount (`/mnt/c/...`).
- **Telegram polling needs working outbound TCP.** WSL inherits the host's network; if the corporate VPN blocks api.telegram.org, the Hermes gateway will retry-loop.
- **Path translation** when piping between Windows tools and WSL — keep Foreman state inside WSL home dir.

---

## After the install: optional follow-ups

### Wire a partner agent
The wizard already installed + registered whatever you picked. Add a new one later with:
```bash
foreman agent add openclaw --type openclaw      # respects the registry catalogue
foreman agent list
```

### Drop the dummy keys, paste real ones
```bash
foreman secrets rotate anthropic-key            # interactive; paste new value
foreman secrets show anthropic-key --yes-i-want-to-see-it
```

### Look at Foreman's identity persona
```bash
foreman identity show                            # the SOUL.md every agent inherits
foreman identity edit                            # opens $EDITOR; on save re-propagates
foreman identity push                            # re-sync after manual edits
```

### Set up shell completion
```bash
foreman completion zsh > ~/.zsh/completions/_foreman
# or
foreman completion bash > /etc/bash_completion.d/foreman
```

### Run the doctor whenever something feels off
```bash
foreman doctor
# 14 checks across: node version, paths, identity, db, fts5, policy, agents,
# mcp gateway, legacy home, updates, chafa.
# Exit code: 0 (all green) / 1 (warn) / 2 (fail).
```

---

## Uninstall

Same on every platform:
```bash
# 1. Drop the global package
npm uninstall -g foreman-agent

# 2. Remove the foreman home (back it up if you want the audit log preserved)
# macOS
rm -rf "$HOME/Library/Application Support/foreman" "$HOME/Library/Caches/foreman"
# Linux / WSL
rm -rf ~/.config/foreman ~/.local/state/foreman ~/.cache/foreman
# Windows native
# Remove %APPDATA%\foreman and %LOCALAPPDATA%\foreman\Cache

# 3. (optional) Remove the Foreman SOUL injection from each agent's identity hook
rm -f ~/.hermes/SOUL.md ~/.claude/CLAUDE.md ~/.codex/AGENTS.md
```

---

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| `foreman: command not found` after install | Re-source your shell (`hash -r` / new terminal) or check `npm prefix -g` is on PATH. |
| `foreman start` skips the wizard | The foreman home already exists with registered agents. Either wipe it (see Uninstall) or re-run the wizard explicitly with `foreman setup --resume` or `foreman setup --reset`. |
| Wizard's Step 1 doesn't ask for key values | You probably hit Enter on an empty MultiSelect. As of PR #148 the three common keys are pre-checked — make sure you're on a build that includes the merge. |
| OpenClaw / Codex toggle didn't take in the wizard | The `@inkjs/ui` MultiSelect selected state can be subtle. Check the install-step summary line `Selected agents: …` — if your pick isn't there, Esc back, Space again, Enter. |
| Telegram polling fails on Linux | Check outbound TCP to `api.telegram.org` (149.154.166.110:443) isn't blocked. The gateway prints `httpx.ConnectError: All connection attempts failed` in journalctl. |
| Bot still says "Hermes Agent" not "Foreman" after registration | Run `hermes sessions prune --older-than 0 --yes` then restart the gateway — cached session prompt from before the SOUL write. |
| `foreman doctor` exits 1 on a fresh box | Normal — usually `agents_registered` (no agents yet) + `chafa` (optional) warnings. Exit 2 is a real failure (missing identity.key, corrupt DB, malformed policy.yaml). |

Open an issue at `github.com/tuzlu07x/foreman/issues` if something here doesn't match what you see.
