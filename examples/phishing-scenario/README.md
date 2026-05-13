# Phishing scenario demo

The 3-minute cast that goes at the top of the README and into the launch tweet. This directory is the infrastructure to record it deterministically — same beats, same email content, same timing every run.

## Files

| File            | Purpose                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `play.mjs`      | Drives `foreman mcp-stdio` with timed `tools/call` messages — stands in for Claude Code's traffic in the demo. |
| `run-demo.sh`   | Boots Foreman + `play.mjs` side-by-side in a tmux session.                                                     |
| `STORYBOARD.md` | 3-minute beat-by-beat with what each pane shows and when.                                                      |

## Run it (no recording)

```bash
# from the repo root
npm run build
./examples/phishing-scenario/run-demo.sh
```

That opens a two-pane tmux session: left pane is Foreman's TUI, right pane is `play.mjs` walking through the script. Decide on the approval modal when it pops (around 1:00) — try pressing `i` first, then `d` to deny.

## Record an asciinema

Real terminal, real recording — the produced cast lives at `assets/demo.cast`.

```bash
# 1. install asciinema if you don't have it
brew install asciinema   # or pipx install asciinema

# 2. record (size ≥ 200×50 helps the boot banner render properly)
mkdir -p assets
asciinema rec --idle-time-limit 2 assets/demo.cast \
  -c './examples/phishing-scenario/run-demo.sh'

# 3. (optional) trim the head / tail with asciinema-cut or any text editor

# 4. produce a GIF mirror for README badges
agg --idle-time-limit 1 --rows 50 --cols 200 assets/demo.cast assets/demo.gif
```

Or as SVG for a lighter README embed:

```bash
npx svg-term-cli --in assets/demo.cast --out assets/demo.svg --window
```

Then upload to asciinema.org (`asciinema upload assets/demo.cast`) and drop the badge into the README.

## Troubleshooting

| Symptom                                        | Fix                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `tmux is required for the orchestrated layout` | `brew install tmux` (or your package manager).                                                                                       |
| `foreman binary not found`                     | Run `npm run build` first. `run-demo.sh` falls back to `dist/cli/index.js` if `$PATH` doesn't have a global install.                 |
| The approval modal never appears               | `examples/policy.yaml` must **not** allow `read_file` for `claude-code`. The demo relies on the default `ask` + risk-threshold path. |
| `play.mjs` echoes `→` lines into the TUI pane  | You're attached to pane 2. Switch with `Ctrl-b ←` / `→`.                                                                             |

## What's intentionally not committed

- `assets/demo.cast` itself — recorded per-author with their preferred terminal font / theme. The file is gitignored as a build artifact (and tracked separately when finalised for the launch).
- The GIF / SVG mirror — same reason.

## See also

- [`STORYBOARD.md`](./STORYBOARD.md) — beat-by-beat timing and "what the viewer should be feeling" notes
- [`../mock-agent/README.md`](../mock-agent/README.md) — the canned email fixture
- [`../claude-code/README.md`](../claude-code/README.md) — how a real MCP client (not `play.mjs`) hooks into Foreman
