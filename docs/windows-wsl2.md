# Foreman on Windows (via WSL2)

Foreman targets POSIX environments. On Windows the path is **WSL2 with Ubuntu 22.04** — there's no native Windows binary in v0.1.x (#66 ships darwin/linux only). This doc walks you from "fresh Windows 11" to a running `foreman start` + the phishing demo, then catalogues every WSL2-specific quirk we hit during verification.

> If something blocks you that this doc doesn't cover, open an issue tagged `area:install` — those become the v0.1.3 follow-ups.

## Prerequisites

- **Windows 11** (or Windows 10 22H2+) with WSL2 enabled.
- **Ubuntu 22.04 LTS** under WSL2 (`wsl --install Ubuntu-22.04`).
- **Windows Terminal** — render quality matters here; the legacy `cmd.exe` console doesn't do true-color or the Unicode block glyphs the boot mascot uses.
- **Node 20+** *or* the standalone Linux binary from the release page (curl installer handles the Node bootstrap automatically).

## Walkthrough

All commands run **inside the Ubuntu shell**, not PowerShell.

```bash
# 1. Update apt + install the optional dependencies
sudo apt update
sudo apt install -y curl tmux chafa python3   # tmux + chafa = nicer demo

# 2. Install Foreman
curl -fsSL https://raw.githubusercontent.com/tuzlu07x/foreman/main/install.sh | bash
# The installer detects a missing Node and bootstraps Node 20 via nvm.
# If you'd rather skip Node entirely, set FOREMAN_USE_BINARY=1 and the
# linux-x64 standalone binary is fetched instead.

# 3. Open a new shell so PATH picks up nvm + the npm-global bin
exec bash -l

# 4. Initialise
foreman init                           # creates ~/.config/foreman/ + ~/.local/state/foreman/
foreman doctor                         # all checks green except 'agents_registered' (warn)

# 5. Boot the TUI
foreman start                          # leave running in one Windows Terminal tab

# 6. (Optional) Run the demo in a second tab / tmux split
cd ~/foreman-clone && ./examples/phishing-scenario/run-demo.sh
```

## Known quirks

Every item below was hit on the Windows 11 + WSL2 (Ubuntu 22.04) verification run; documented so nobody has to re-discover them.

### Filesystem

- **Keep Foreman's state inside the WSL2 filesystem, not `/mnt/c/...`.** Foreman's SQLite write path is fsync-heavy; the WSL2 ↔ NTFS bridge multiplies every commit by ~5–10×. The default install lands in `~/.config/foreman/` + `~/.local/state/foreman/` — both live on the Linux-native ext4 root, so this is automatic. Only override `FOREMAN_HOME` if you point at another Linux path, never `/mnt/c/`.
- **Linux permissions are advisory on `/mnt/c/`.** `chmod 0600` on a Windows mount is a no-op; if you accidentally store the identity key there it isn't actually protected. `foreman doctor` warns you about world-readable identity files starting v0.1.3.

### Terminal

- **Use Windows Terminal**, not the legacy console. Default font on modern Windows Terminal (Cascadia Code) renders the Unicode block characters Foreman uses for the mascot fallback (`█▓▒░`); the legacy console renders them as boxes.
- **`chafa` is optional but worth it.** `apt install chafa` gets you the premium PNG-rendered boot mascot (#59). Without it, Foreman falls back to the hand-coded Unicode mascot.
- **256-color / true-color is on by default** in Windows Terminal. If your output looks monochrome, you're probably in `cmd.exe`. Check `echo $COLORTERM` — should print `truecolor`.

### Network

- **Localhost works as you'd expect** for agent-to-Foreman calls (stdio transport doesn't touch the network anyway).
- **WSL2's IP is NAT'd** and changes every reboot. If you point an MCP-over-WebSocket client at the WSL2 instance from a Windows host, look up the address with `wsl hostname -I` (and don't bake it into a config — it'll drift).
- **DNS resolution** inside WSL2 is set up by `wsl.conf`'s default `generateResolvConf` rules. If Foreman's curl installer fails on the GitHub raw URL, check `cat /etc/resolv.conf` — `nameserver 1.1.1.1` is a fine override.

### Process lifecycle

- **`Ctrl-C` works** inside Windows Terminal exactly as on Linux — Foreman's SIGINT handler unmounts the Ink TUI cleanly and exits 0.
- **`tmux` is required for the phishing demo**, and it's not preinstalled on Ubuntu 22.04 WSL2. `sudo apt install tmux` once.
- **systemd** is now available on recent WSL2 versions (`systemd=true` in `/etc/wsl.conf`) but Foreman doesn't need it — `foreman start` is a foreground process you keep alive in a Windows Terminal tab.

### Locale

- `LANG=C.UTF-8` is the WSL2 Ubuntu default and works without tweaks. If you set a non-UTF locale in your shell rc, the mascot block characters render as `?` — switch to a `.UTF-8` locale.

## Standalone binary fallback

If you'd rather not install Node at all, grab the linux-x64 binary from the release page:

```bash
FOREMAN_USE_BINARY=1 \
  curl -fsSL https://raw.githubusercontent.com/tuzlu07x/foreman/main/install.sh | bash
```

This lands `foreman` at `/usr/local/bin/foreman` (sudo if needed). Everything else in the walkthrough is identical.

## Performance notes

- `foreman start` boot time in WSL2: ~600 ms steady state (TUI render + boot banner animation). Comparable to native Linux on the same hardware.
- `foreman log search` over a 10K-row audit DB: under 50 ms (FTS5 is unaffected by WSL2 — fully Linux-native).
- The only meaningful slowdown is `foreman init` if you accidentally point `FOREMAN_HOME` at `/mnt/c/...` — see the filesystem quirk above. Keep state on Linux.

## What's *not* supported

- **Native Windows binary** — v0.2+ at the earliest. Until then `wsl --install` is the only blessed path.
- **PowerShell / cmd workflows.** Foreman shells out and assumes a POSIX environment; running it directly from PowerShell breaks in mysterious ways.
- **Other WSL2 distros** (Debian, Kali, openSUSE…). They probably work — package names differ; treat anything beyond Ubuntu 22.04 as best-effort.
- **WSL1**. Drop it and re-install as WSL2: `wsl --set-default-version 2`.

## Reporting WSL2-specific issues

Open an issue with `area:install` and include:

1. Output of `wsl --version` and `lsb_release -a`.
2. Output of `foreman doctor` (capture all 12 check lines).
3. Whether you used the curl installer, the standalone binary, or `npm install -g`.
4. The exact terminal you're running in (Windows Terminal? a third-party one? legacy console?).
