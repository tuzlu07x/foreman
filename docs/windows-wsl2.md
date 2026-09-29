# Foreman on Windows (via WSL2)

Foreman targets POSIX environments. On Windows the path is **WSL2 with Ubuntu 22.04** — there's no native Windows binary in v0.1.x (#66 ships darwin/linux only). This doc walks you from "fresh Windows 11" to a running `foreman start` + the phishing demo, then catalogues every WSL2-specific quirk we hit during verification.

> If something blocks you that this doc doesn't cover, open an issue tagged `area:install` — those become the WSL2 follow-ups.

## Prerequisites

- **Windows 11** (or Windows 10 22H2+) with WSL2 enabled.
- **Ubuntu 22.04 LTS** under WSL2 (`wsl --install Ubuntu-22.04`).
- **Windows Terminal** — render quality matters here; the legacy `cmd.exe` console doesn't do true-color or the Unicode block glyphs the boot mascot uses.
- **Node 22.12+** *or* the standalone Linux binary from the release page (the curl installer sets up Node 22 through nvm when it's missing).

## Walkthrough

All commands run **inside the Ubuntu shell**, not PowerShell.

```bash
# 1. Update apt + install the optional dependencies
sudo apt update
sudo apt install -y curl tmux python3   # tmux = nicer demo

# 2. Install Foreman
curl -fsSL https://raw.githubusercontent.com/tuzlu07x/foreman/main/install.sh | bash
# The installer detects a missing Node and bootstraps Node 22 via nvm.
# If you'd rather skip Node entirely, use the standalone binary instead
# (see "Standalone binary fallback" below).

# 3. Open a new shell so PATH picks up nvm + the npm-global bin
exec bash -l

# 4. Initialise
foreman init                           # creates ~/.config/foreman/ + ~/.local/state/foreman/
foreman doctor                         # exit 1 (warnings only) is normal: no agents yet, agent CLIs not installed

# 5. Boot the TUI
foreman start                          # leave running in one Windows Terminal tab

# 6. (Optional) Run the demo in a second tab / tmux split
cd ~/foreman-clone && ./examples/phishing-scenario/run-demo.sh
```

## Known quirks

Every item below was hit on the Windows 11 + WSL2 (Ubuntu 22.04) verification run; documented so nobody has to re-discover them.

### Filesystem

- **The daemon runs inside WSL2, not on native Windows.** `foreman start` listens on a Unix socket in the state directory, which works on WSL2's ext4 root like on Linux. Native Windows has no daemon: agents' `foreman mcp-stdio` and hook calls run Foreman in their own process there.
- **Keep Foreman's state inside the WSL2 filesystem, not `/mnt/c/...`.** Foreman's SQLite write path is fsync-heavy; the WSL2 ↔ NTFS bridge multiplies every commit by ~5–10×. The default install lands in `~/.config/foreman/` + `~/.local/state/foreman/` — both live on the Linux-native ext4 root, so this is automatic. Only override `FOREMAN_HOME` if you point at another Linux path, never `/mnt/c/`.
- **Linux permissions are advisory on `/mnt/c/`.** `chmod 0600` on a Windows mount is a no-op; if you accidentally store the identity key there it isn't actually protected. `foreman doctor` warns you about world-readable identity files.

### Terminal

- **Use Windows Terminal**, not the legacy console: the TUI's borders and the colour-block mascot need a modern terminal.
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

If you'd rather not install Node at all, grab the linux-x64 binary from the release page (the installer script only does the npm install):

```bash
base=https://github.com/tuzlu07x/foreman/releases/latest/download
curl -fsSLO "$base/foreman-linux-x64" && curl -fsSLO "$base/SHA256SUMS"
grep ' foreman-linux-x64$' SHA256SUMS | sha256sum -c -
chmod +x foreman-linux-x64 && sudo mv foreman-linux-x64 /usr/local/bin/foreman
```

Everything else in the walkthrough is identical. Keep `FOREMAN_HOME` (and your home directory) on the Linux filesystem: the binary unpacks a few files into Foreman's cache dir and only trusts a directory that nobody else can write to. A Windows mount like `/mnt/c` (without the `metadata` mount option) shows everything as world-writable, so there it unpacks them into a temp dir on every start instead. See [install.md](install.md#standalone-binary-no-nodejs).

## Performance notes

- `foreman start` boot time in WSL2: ~600 ms steady state (TUI render + boot banner animation). Comparable to native Linux on the same hardware.
- `foreman log search` over a 10K-row audit DB: under 50 ms (FTS5 is unaffected by WSL2 — fully Linux-native).
- The only meaningful slowdown is `foreman init` if you accidentally point `FOREMAN_HOME` at `/mnt/c/...` — see the filesystem quirk above. Keep state on Linux.

## What's *not* supported

- **Native Windows binary** — not planned yet. Until then `wsl --install` is the only blessed path.
- **PowerShell / cmd workflows.** Foreman shells out and assumes a POSIX environment; running it directly from PowerShell breaks in mysterious ways.
- **Other WSL2 distros** (Debian, Kali, openSUSE…). They probably work — package names differ; treat anything beyond Ubuntu 22.04 as best-effort.
- **WSL1**. Drop it and re-install as WSL2: `wsl --set-default-version 2`.

## Reporting WSL2-specific issues

Open an issue with `area:install` and include:

1. Output of `wsl --version` and `lsb_release -a`.
2. The full output of `foreman doctor`.
3. Whether you used the curl installer, the standalone binary, or `npm install -g`.
4. The exact terminal you're running in (Windows Terminal? a third-party one? legacy console?).
