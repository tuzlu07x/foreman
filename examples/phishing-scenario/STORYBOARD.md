# Phishing demo storyboard

Targeting a 3-minute asciinema. Matches FOREMAN-TUI.md §11 beat-by-beat.

| Time          | Pane left (Foreman TUI)                                                                                                                                                       | Pane right (`play.mjs`)                                                                                                                                                                                               | What to focus on                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `0:00`        | Boot banner appears. Mascot + gradient FOREMAN. Init checkmarks fade in 80ms apart.                                                                                           | Idle — `play.mjs` is queued behind a 1.5s tmux delay.                                                                                                                                                                 | The brand reveal. Banner sells the personality before any words.                           |
| `0:15`        | Empty dashboard. Agents/Activity panels visible. Status bar shows hotkeys.                                                                                                    | `→ initialize` and `→ tools/list` arrive. `← {…}` replies stream back.                                                                                                                                                | Foreman handshakes cleanly. Activity is still empty (no decisions yet).                    |
| `0:30`        | `claude-code ●` appears in Agents (auto-registered).                                                                                                                          | `→ tools/call read_file(src/auth.ts)` and `→ list_files(src/)`.                                                                                                                                                       | Two routine allows. `✓ allow · auto · Xms` rows fly into Activity.                         |
| `1:00`        | Stats panel shows Allowed `████ 100%`.                                                                                                                                        | Pause.                                                                                                                                                                                                                | The dashboard has been _lived in_ for 30s now. The flat normalcy is the setup.             |
| `1:00`–`1:30` | `play.mjs` prints `=== act 3 — phishing beat ===` and a description line, then sends `read_file(".env")`.                                                                     | Mediator routes through risk. `.env` → secret_file_pattern +50, first cross-agent +20 → score 70. Approval modal pops mid-screen, yellow border, `⚠ Approval Required risk: 70`. Timer starts counting down from 60s. | The drama. The dashboard is interrupted. Mascot in the modal corner stays orange and calm. |
| `1:30`        | Operator hits `i`. Inspect view opens: request chain, suspicious signals with prose, full args JSON.                                                                          | Operator can see _why_ this looks bad without trusting the agent.                                                                                                                                                     |
| `2:00`        | Operator hits `Esc` → back to modal (timer preserved).                                                                                                                        | The timer didn't pause — that's a visible value prop.                                                                                                                                                                 |
| `2:05`        | Operator hits `d` (or `D` for always-deny).                                                                                                                                   | Modal closes. Approval resolved.                                                                                                                                                                                      |
| `2:10`        | Activity feed now shows the denied row at the top in red: `✗ deny · user · risk:70`.                                                                                          | Dashboard is back. The phishing attempt is on the record.                                                                                                                                                             |
| `2:20`        | Operator hits `l` for the Logs page. `/` then types `env` — FTS5 search filters down to the denied row.                                                                       | The audit story: every decision is greppable, forever.                                                                                                                                                                |
| `2:35`        | Operator hits `Esc` → back to dashboard.                                                                                                                                      | Reset.                                                                                                                                                                                                                |
| `2:45`        | `play.mjs` sends `shell_exec("ls")` as the outro. Foreman's policy (from `examples/policy.yaml`) has `*` → `tool:shell_exec` deny. The request is denied _without_ prompting. | Operator never sees a modal — policy did the work. The denied row appears in Activity.                                                                                                                                |
| `3:00`        | Final frame. Status bar visible. Mascot 🦫 in the corner.                                                                                                                     | Hold for the outro card / overlay.                                                                                                                                                                                    |

## Recording checklist

- Terminal size ≥ 200×50 (matches `tmux new-session -x 200 -y 50`).
- Font: monospace at a comfortable size. Test the mascot rendering before recording.
- `asciinema rec --idle-time-limit 2` — keeps the cast from sitting idle during the `play.mjs` `sleep 75000`. The idle clip looks better than real time.
- After recording, trim the end so the cast stops on the outro frame (don't ship 30s of empty dashboard).
- Convert to GIF for places that don't render asciinema:
  ```bash
  # asciinema → gif
  agg --idle-time-limit 1 --rows 50 --cols 200 assets/demo.cast assets/demo.gif
  ```
- Or to SVG (lighter for README):
  ```bash
  npx svg-term-cli --in assets/demo.cast --out assets/demo.svg --window
  ```

## Tweaks if a beat doesn't land

- **Banner feels rushed**: bump the boot stagger from 80ms (`STAGGER_MS` in `boot-banner.tsx`) to ~120ms just for the recording.
- **`.env` doesn't trigger approval**: make sure `examples/policy.yaml` does **not** include an explicit allow for `tool:read_file` — the demo relies on the default `ask` + risk-threshold path.
- **Modal feels static**: hold for an extra ~2s after `i` so the inspect view is readable.
