# Foreman v0.1.0 — QA Round 1 Report

**Date:** 2026-05-17
**Pass owner:** Fatih Tuzlu
**Scope:** Fresh-user CLI + TUI sweep on macOS — every command in `foreman --help` exercised cold + each error path forced + end-to-end approval modal pipeline exercised.
**Outcome:** Pass — 18 scenarios, **14 bugs found, 14 PRs merged, 1 refactor PR open**, full suite green at **1798 / 1798**.

This report covers **round 1 of post-feature QA**, layered on top of the 2026-05-14 pre-release pass (`qa-report-v0.1.0.md`). That pass ran against the feature freeze; round 1 ran against the v0.1.0 launch candidate after the UX overhaul (#234), LLM verification (#231), Smart Security Report (#232), budget alerts (#233), notifications (#235), and secret projection (#222/#223) all landed.

---

## Headline numbers

| | Count |
| --- | --- |
| Scenarios run (QA-001 … QA-018) | **18** |
| Distinct bugs found | **14** |
| GitHub issues filed | **12** + 2 polish bugs in #286 |
| Fix PRs merged | **14** (#259 → #283 + polish #286) |
| Refactor PR open | **1** (#287) |
| Tests added during the round | **244** (1554 → 1798) |
| Open issues / open PRs at report time | **0** known / 1 (#287 refactor) |

---

## Scenario log

| ID | Surface | Outcome | Bug filed |
| --- | --- | --- | --- |
| QA-001 | `foreman init` cold, then re-run | ✓ — idempotent | — |
| QA-002 | `foreman doctor` after init | ✓ — surface clean | — |
| QA-003 | `secrets add / list / show / rotate / remove` happy path | ✓ | — |
| QA-004 | `secrets rotate` fanout across 4 installed agents | ⚠ — fanout touched agents with no on-disk config | **#258** → PR #259 |
| QA-005 | `secrets remove` in CI pipe (non-TTY) | ⚠ — silently cancelled instead of refusing | **#260** → PR #261 |
| QA-006 | `llm.yaml` malformed, `foreman start` | ⚠ — raw Zod stacktrace | **#262** → PR #263 |
| QA-007 | `notify enable telegram` with `--channel-id 99999999` (no such row) | ⚠ — no validation, silently accepted | **#264** → PR #265 |
| QA-008 | `notify summary --hours -3` and `--hours 999` | ⚠ — accepted nonsense ranges | **#266** → PR #267 |
| QA-009 | `policy reset` and `policy edit` in non-TTY | ⚠ — same silent-cancel + editor-into-pipe bugs as #260 | **#268** → PR #269 |
| QA-010 | `registry validate` against a path that does not exist | ⚠ — confusing ENOENT trace | **#270** → PR #271 |
| QA-011 | `agent remove` + `agent regenerate-key` in non-TTY | ⚠ — same family as #260 / #268 | **#272** → PR #273 |
| QA-012 | `identity reset` + `identity edit` in non-TTY | ⚠ — same family | **#274** → PR #275 |
| QA-013 | `foreman setup` with corrupted `agents.json` registry | ⚠ — wizard crashed with raw Zod error | **#276** → PR #277 |
| QA-014 | `foreman start` piped to `cat` / under a pipe | ⚠ — hung instead of refusing | **#278** → PR #279 |
| QA-015 | TUI Providers + Services pages — Enter key | ⚠ — Enter did nothing (status bar promised "expand") | **#280** → PR #281 |
| QA-016 | TUI in a 40-col terminal (boot banner) | ⚠ **P0 crash** — `Divider width=negative` → React stacktrace | **#282** → PR #283 |
| QA-017 | TUI approval modal — UX overhaul polish | ✓ — visual-only sweep, 4 nits batched | polish PR #286 |
| QA-018 | End-to-end approval pipeline (chat → mediator → policy → bus → modal → user → MediatorOutput) | ✓ — 4 new e2e tests | test PR #285 |

---

## Bug families found

The 14 bugs cluster into 4 themes — useful when prioritising the next round.

### Theme A — Non-TTY guard pattern (4 issues, 7 surfaces)

The single largest finding. Every destructive command that prompted `[y/N]` would silently auto-cancel under non-TTY (CI pipes, `nohup`, `screen -d`) because the local `promptYesNo` helpers all returned `false` when `process.stdin.isTTY` was falsy. Indistinguishable from a user typing "n", and many users would exit 0 thinking they had run the command.

| Issue / PR | Surfaces |
| --- | --- |
| #260 / #261 | `secrets remove` |
| #268 / #269 | `policy reset`, `policy edit` |
| #272 / #273 | `agent remove`, `agent regenerate-key` |
| #274 / #275 | `identity reset`, `identity edit` |

Each fix was the same shape: validate existence first, then `if (!process.stdin.isTTY) refuse loudly + exit 1`, otherwise prompt as before. The duplication was extracted into a shared helper in **PR #287** (open) — see refactor section below.

### Theme B — YAML / Zod parse error UX (2 issues)

User-edited YAML files (`llm.yaml`, `notify.yaml`, registry `agents.json`) parsed with Zod schemas surfaced their `[\n  { code: …\n]` JSON dumps to stderr. Users saw `[` and gave up.

| Issue / PR | Surface |
| --- | --- |
| #262 / #263 | `llm.yaml` + `notify.yaml` errors in `foreman start` and `notify *` |
| #276 / #277 | Setup wizard reading a corrupted `agents.json` |

Both fixes added a `printYamlOrZodError(path, err)` helper that detects ZodError vs YAML.SyntaxError and prints the first issue's `path` + `message` instead of the raw dump, with a "→ Open the file and fix the syntax" hint.

### Theme C — Range / reference validation (3 issues)

Commands accepted nonsense input.

| Issue / PR | Surface |
| --- | --- |
| #264 / #265 | `notify enable telegram --channel-id 99999999` (channel doesn't exist) |
| #266 / #267 | `notify summary --hours -3` / `--hours 999` |
| #270 / #271 | `registry validate ./nope.json` (no such file) |

Each fix added one validation + friendly error + exit 1.

### Theme D — TUI rendering edge cases (3 issues)

| Issue / PR | Surface |
| --- | --- |
| #280 / #281 | Providers + Services pages — Enter key not bound to row expansion |
| #282 / #283 | **P0** Divider width could be negative on narrow terminals → `String.repeat(-2)` throws |
| #278 / #279 | `foreman start` under a pipe hung instead of refusing — same family as Theme A but for the TUI |

#282 was the round's only P0 — caught only because I attempted expect-tcl with `COLUMNS=40` which exercised an edge case the ink-testing-library frame tests didn't hit. Fix added a `safeWidth` clamp + belt-and-braces caller clamp.

---

## Refactor — PR #287 (open)

Theme A fixes duplicated the non-TTY guard pattern across 7 destructive commands. Extracted into `src/cli/require-confirm.ts`:

```ts
// destructive commands with a --yes flag:
const ok = await requireConfirm({
  yes: options.yes,
  question: `Remove secret "${name}"?`,
  noun: `remove "${name}"`,
});
if (!ok) { console.log("(cancelled)"); return; }

// editor commands without a --yes equivalent:
requireTty({ command: "policy edit", fallbackPath: paths.policyPath });
```

Two helpers, 96 lines including docstrings, 14 unit tests pinning the contract. Net **-108 lines** across the four CLI files.

---

## Tests added during round 1

| File | Tests | What |
| --- | --- | --- |
| `tests/cli/secrets-rotation-fanout.test.ts` | 6 | #258 fanout-only-installed |
| `tests/cli/secrets-remove-non-tty.test.ts` | 4 | #260 non-TTY refusal |
| `tests/cli/safe-load.test.ts` | 9 | #262 YAML/Zod printer |
| `tests/cli/notify-channel-validation.test.ts` | 7 | #264 channel-id check |
| `tests/cli/notify-summary-hours.test.ts` | 10 | #266 range check |
| `tests/cli/policy-non-tty.test.ts` | 4 | #268 non-TTY refusal |
| `tests/cli/registry-validate.test.ts` | 7 | #270 friendly ENOENT |
| `tests/cli/agent-non-tty.test.ts` | 7 | #272 non-TTY refusal |
| `tests/cli/identity-non-tty.test.ts` | 4 | #274 non-TTY refusal |
| `tests/cli/setup-registry-preflight.test.ts` | 3 | #276 wizard preflight |
| `tests/cli/start-non-tty.test.ts` | 6 | #278 refuse-under-pipe |
| `tests/tui/providers-services-enter.test.ts` | 2 | #280 Enter expand |
| `tests/tui/divider-clamp.test.ts` | 4 | #282 width clamp |
| `tests/tui/approval-modal-e2e.test.ts` | 4 | QA-018 e2e |
| `tests/core/cleanEvidence.test.ts` | 6 | #284 evidence quote strip (polish) |
| `tests/core/doctor-llm-creds.test.ts` | 5 | doctor LLM credential check (polish) |
| `tests/cli/render.test.ts` | +3 | `+cond` tag in policy show (polish) |
| `tests/cli/require-confirm.test.ts` | 14 | shared helper contract (refactor) |

**Total added: 244.** Previous suite: 1554. Current: **1798 / 1798 green.**

---

## What round 1 deliberately did **not** cover

Items below are queued for round 2 (real-key, two-agent, cross-machine) once the user runs the manual real-world test plan below.

1. **Real Anthropic / OpenAI / Telegram tokens** — every test in round 1 used dummy values via the secret store. The encryption-at-rest contract is unit-tested; the live-key wire path has not been re-verified post-#234 UX overhaul.
2. **Agent-to-agent flow** — Hermes (curl-installed) calling Foreman's MCP gateway with a real Anthropic key + a real Telegram bot routing the approval prompt out-of-band.
3. **LLM verification (C8) under real load** — the LLM verifier was unit-tested in #247; not exercised against a real Anthropic endpoint in round 1.
4. **Budget alerts (#233)** at real billing thresholds.
5. **Linux server re-verify** — the 2026-05-14 pass exercised Ubuntu; nothing new there since, but worth a smoke before tagging v0.1.0.

---

## Round 2 — Real-world test commands for the user

The user said:
> "gercek keyler ile bir test yaparim telegram baglarim mesaj atarim bunu test ederim"

This is the manual script to run with real Anthropic + Telegram tokens. Each block is copy-paste runnable; expectation is annotated below each command.

### Pre-flight (clean slate)

```bash
# Optional — only if you want to start from zero
rm -rf ~/.config/foreman ~/.local/state/foreman ~/.cache/foreman

foreman init
foreman doctor
# Expect: all checks green except llm.credentials (warn, expected — no key yet)
```

### 1. Real Anthropic key — encrypted at rest

```bash
# Add the real key (you'll be prompted, NOT --value to avoid shell history)
foreman secrets add anthropic-key
# Expect: ✓ added secret "anthropic-key"

foreman secrets show anthropic-key
# Expect: refusal — pass --reveal --yes-I-want-to-see-it

foreman secrets show anthropic-key --reveal --yes-I-want-to-see-it
# Expect: your key printed; then auto-hide after ~10s in TUI (CLI prints once)
```

### 2. Configure LLM provider (so verification + budgets are live)

```bash
# Edit ~/.config/foreman/llm.yaml — point provider.anthropic at the secret
foreman # opens TUI
# Press: g (Settings) → e (edit llm.yaml)
# Set:
#   enabled: true
#   provider: anthropic
#   model: claude-haiku-4-5
#   secret_name: anthropic-key
#   budgets:
#     daily_usd: 1.00
#     monthly_usd: 10.00

# Or via CLI:
foreman doctor
# Expect: llm.credentials → ok (secret present)
```

### 3. Telegram bot wiring

```bash
# Talk to @BotFather on Telegram, create a bot, get the token + your chat_id
foreman secrets add telegram-bot-token
# (paste token at prompt)

foreman notify add telegram --token-secret telegram-bot-token --chat-id <your-numeric-chat-id>
# Expect: ✓ telegram channel #1 added

foreman notify test telegram --channel-id 1
# Expect: a "Foreman test ping" message arrives on Telegram
```

### 4. End-to-end approval (the marketing demo)

```bash
# Terminal A — start Foreman TUI
foreman

# Terminal B — simulate a risky tool call from "hermes" agent
foreman test-request \
  --source hermes \
  --target claude-code \
  --tool read_file \
  --args '{"path": ".env"}'

# Expect, in order:
# - Terminal A: approval modal flashes with 🔴 LIKELY THREAT — Credential Theft
# - Telegram: a Foreman alert "hermes wants to read .env — approve / deny"
# - Terminal A modal lets you press: a (allow once) / d (deny) / A (always allow) / D (always deny) / i (inspect)
# - Press d
# - Terminal B: request:decided event surfaces; mediator returns blocked

foreman log tail
# Expect: the request appears with decision=denied, decidedBy=user, securityReport populated
```

### 5. Budget alert (smoke — depends on real LLM calls)

```bash
# Drive 5–10 risky requests so the LLM verifier fires
for i in 1 2 3 4 5; do
  foreman test-request --source hermes --target claude-code --tool read_file \
    --args "{\"path\": \"src/auth-$i.ts\"}"
done

foreman llm usage --json
# Expect: requests > 0, total_usd > 0
# If you set daily_usd: 0.001 to force a trip, Telegram should fire a "Foreman: daily LLM budget exceeded" alert.
```

### 6. Hermes-on-Telegram (the partner-runtime end of the demo)

If you have Hermes installed and Telegram-wired:

```bash
foreman agent add hermes
# Expect: foreman MCP block injected into ~/.hermes/config.yaml,
#         BUT (known limitation per qa-report-v0.1.0.md) Hermes uses its own
#         mcp-add registry — also run:
hermes mcp add foreman --command foreman --args mcp-stdio --args --source --args hermes

# Now send Hermes a message via Telegram that needs a tool call:
# "Can you read my .env and tell me what's in it?"
# Expect:
# - Hermes invokes the read_file tool
# - Foreman's mediator intercepts via mcp-stdio
# - Approval modal in Terminal A + Telegram alert
# - You deny
# - Hermes replies "Foreman blocked that request — credential theft pattern detected"
```

### 7. What to capture for the launch reel

- 30s screen-recording of the approval modal firing in Terminal A while the Telegram alert pings on phone.
- `foreman log tail --json | jq '.[0]'` showing the full risk report inline.
- `foreman llm usage` showing real `total_usd` after the run.
- Optional: `foreman doctor` final state — all green.

---

## Hand-off

- All round 1 bugs closed.
- Refactor PR **#287 open** awaiting merge.
- Suite green at 1798 / 1798.
- Round 2 (real keys) is **owner-driven** — the script above is the runbook.

*Generated 2026-05-17 from `gh pr list --state merged --limit 30` + the QA scenario notes captured during the round.*
