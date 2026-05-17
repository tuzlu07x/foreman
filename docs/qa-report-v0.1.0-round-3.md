# Foreman v0.1.0 — QA Round 3 Manual Test Runbook

**Date:** 2026-05-18
**Scope:** Comprehensive manual validation of every v0.1.0 feature shipped across PRs #319-#338 (20 issues). Real keys, real Telegram, real installed agents.
**Outcome target:** All scenarios pass + 30-second demo reel captured.

This document is **the** runbook the launch-day pass runs. Round 1 caught 14 bugs across 18 scenarios; round 2 found 5 more in fresh setup. Round 3 verifies all those are fixed AND every new feature actually works in a real terminal with real keys.

---

## How to use this doc

1. Work top to bottom. Each section has setup → action → expected outcome.
2. Tick the checkbox when the scenario passes. If it fails, file an issue with the scenario id (e.g. QA3-WIZ-04) and the exact output.
3. Run the **whole pass twice**: once on macOS, once on Linux (Ubuntu 24.04 server). The vision delivers cross-platform — round 3 confirms.
4. Where two paths exist (e.g. Anthropic key vs OpenAI key), run both.

---

## 0. Pre-flight

| Need | Details |
|---|---|
| Anthropic key | `sk-ant-...` — for LLM verification scenarios |
| OpenAI key | `sk-proj-...` — for multi-provider scenarios |
| Telegram bot | From @BotFather; user's own chat_id known |
| Hermes installed | `curl ... \| bash` per `hermes-agent.nousresearch.com` |
| OpenClaw installed | `npm install -g openclaw` |
| Claude Code installed | `npm install -g @anthropic-ai/claude-code` (optional but valuable) |
| Clean slate command | `rm -rf ~/.config/foreman ~/.local/state/foreman ~/.cache/foreman ~/.foreman` |
| Foreman binary | `foreman --version` → `0.1.0` |

---

## 1. Init + doctor baseline

### QA3-INIT-01 — fresh init from zero

- [ ] Run the clean slate command, then `foreman init`.
- [ ] Expect: `✓ paths`, `✓ policy`, `✓ soul`, `✓ database` — every line green.
- [ ] `~/.config/foreman/policy.yaml` exists and contains `responsibility_policies:` block with 3+ roles (#299 starter set).
- [ ] `~/.config/foreman/SOUL.md` is non-empty.
- [ ] `~/.local/state/foreman/foreman.db` exists.

### QA3-DOC-01 — doctor cold (no agents, no keys)

- [ ] `foreman doctor`
- [ ] Expect at least 13 checks pass, only `chafa` warns. `llm_config`, `voice_config`, `notify_config` all "absent — using defaults".
- [ ] **No legacy ~/.foreman/ check fails** (this catches #270 regression).

### QA3-DOC-02 — doctor with malformed llm.yaml

- [ ] Create a broken llm.yaml: `echo 'enabled: yes\nbad' > ~/.config/foreman/llm.yaml`
- [ ] `foreman doctor`
- [ ] Expect `llm_config` shows the YAML error with `→ Open ...` hint (#262 / #276 friendly errors). NOT a raw stack trace.
- [ ] Delete the bad file; doctor returns to baseline.

---

## 2. Setup wizard — multi-provider + smart gating (#289, #290, #291, #292, #294, #295, #296, #297)

### QA3-WIZ-01 — fresh setup, OpenAI + Anthropic, both agents

- [ ] Clean slate, then `foreman setup`.
- [ ] Step 1 (providers): pick Anthropic + OpenAI. Paste real keys.
  - [ ] After Anthropic paste, **no warning** about wrong format.
  - [ ] After OpenAI paste, **no warning** about wrong format.
- [ ] Step 2 (agents): both Hermes + OpenClaw should be **pre-checked** (LLMs configured). Codex (if shown) **gated** by needs-OpenAI hint.
  - [ ] For Hermes: LLM picker shows ✓ for both Anthropic and OpenAI; pick one.
  - [ ] For OpenClaw: same. Pick the other.
  - [ ] Responsibility notes prompt fires: enter "code writing" for Hermes, "project management" for OpenClaw.
- [ ] Step 3 (services): pick Telegram. Paste bot token + chat_id.
- [ ] Step 4 (install): both agents install / configure / register. Per-agent log shows:
  - [ ] `✓ wrote MCP snippet`
  - [ ] `✓ updated N secrets → ~/.<agent>/...`
  - [ ] **Hermes only**: `ℹ Hermes needs one extra step to route through Foreman:` followed by the `hermes mcp add foreman --command foreman --args "mcp-stdio --source hermes"` command (#328).
  - [ ] `✓ registered as "..."`
- [ ] Done screen shows: "2 LLM providers", "2 agents", "1 service", policy rule count ≥ 6.

### QA3-WIZ-02 — after wizard: every config file actually exists

- [ ] `cat ~/.config/foreman/llm.yaml` → `enabled: true`, `provider: openai` (or anthropic, whichever was first), `credentials.openai.secret_name: openai-key` (#289 fix).
- [ ] `cat ~/.config/foreman/notify.yaml` → `channels.telegram.enabled: true`, `bot_token_ref: telegram-bot-token`, `chat_id: "..."` (#290 fix).
- [ ] `cat ~/.config/foreman/voice.yaml` → `proactive_notifications` populated, `quiet_hours.enabled: true` (#305 fix).
- [ ] `foreman secrets list` shows `anthropic-key`, `openai-key`, `telegram-bot-token`, `telegram-chat-id`. **No `*-api-key` duplicates** (#291 / #325 fix).

### QA3-WIZ-03 — wizard with only one LLM key (smart gating)

- [ ] Clean slate, `foreman setup`.
- [ ] Pick only OpenAI in providers.
- [ ] Step 2 (agents): expect Claude Code (if shown) labelled `⚠ needs Anthropic key — ...` and **not** pre-checked (#297 / #326).
- [ ] OpenClaw pre-checked with OpenAI auto-selected (only choice). Hermes same.
- [ ] Top-of-screen banner: `⚠ Some agents need an LLM key you haven't configured yet ...`

### QA3-WIZ-04 — paste validation catches cross-provider key

- [ ] During QA3-WIZ-01 providers step, paste a `sk-proj-...` OpenAI key into the Anthropic slot.
- [ ] Expect after submit: warning line `this looks like a OpenAI key (starts with "sk-proj-"), but you're saving it as Anthropic. Saved anyway — fix with foreman secrets rotate anthropic-key if it was a paste error.` (#291 / #325 fix).
- [ ] Wizard proceeds (warn, don't reject).

### QA3-WIZ-05 — paste validation catches sk-ant in OpenAI slot

- [ ] Paste a `sk-ant-...` Anthropic key into the OpenAI slot.
- [ ] Expect warning naming Anthropic + suggesting `foreman secrets rotate openai-key`.

### QA3-WIZ-06 — setup --resume picks up from a skipped service

- [ ] Run `foreman setup`. Exit at step 3 with Ctrl-C.
- [ ] Run `foreman setup --resume`. Wizard lands on step 3 (services), not back at step 1.

---

## 3. LLM provider factory + tests (#292/#294/#295/#296)

### QA3-LLM-01 — OpenAI provider works end-to-end

- [ ] Set `provider: openai` in llm.yaml. `foreman llm test`.
- [ ] Expect `✓ openai responded in <N>ms`, cost shown.
- [ ] **If it fails with 401 even though the key is correct**, capture the exact error and file a regression of #292.

### QA3-LLM-02 — Anthropic provider works end-to-end

- [ ] Set `provider: anthropic`. `foreman llm test` → `✓ anthropic responded`.

### QA3-LLM-03 — Gemini provider works end-to-end (if user has a Gemini key)

- [ ] Set `provider: gemini`. `foreman llm test` → `✓ gemini responded`.

### QA3-LLM-04 — Ollama unimplemented surfaces clean error

- [ ] Set `provider: ollama`. `foreman llm test`.
- [ ] Expect: `error: LLM provider 'ollama' is not implemented in this build. Configure one of: anthropic, openai, gemini.` (exit 2).
- [ ] Does NOT crash with a stack trace.

### QA3-LLM-05 — missing secret surfaces actionable message

- [ ] Remove the configured key: `foreman secrets remove openai-key --yes`.
- [ ] `foreman llm test`.
- [ ] Expect: `error: Provider 'openai' references secret 'openai-key' which is not in the store. Run: foreman secrets add openai-key` (exit 1).

### QA3-LLM-06 — doctor prefix mismatch warning (#307 / #329)

- [ ] `foreman secrets add anthropic-key --value "sk-proj-wrong-key"` (force the mismatch).
- [ ] Set llm.yaml provider to anthropic. `foreman doctor`.
- [ ] Expect `⚠ llm_credentials` line: `secret "anthropic-key" doesn't match anthropic key format (expected prefix "sk-ant-") (value looks like a OpenAI key)`. Remediation hint included.

---

## 4. Responsibility engine (#299, #300, #301)

### QA3-RESP-01 — policy.yaml responsibility_policies parse

- [ ] `foreman policy show` after fresh init.
- [ ] Expect the responsibility starter set ("code writing", "project management", "code review", "document analysis") to be loaded; CLI surfaces 4+ rules from that block.

### QA3-RESP-02 — violation rule fires on cannot_access path

- [ ] With Hermes registered + `responsibilityNote: "code writing"`:
- [ ] TUI: `c` (Mediator test) → input `read_file {"path":"~/.ssh/id_rsa"}`.
- [ ] Modal opens. Reasons line includes `responsibility_violation`. Risk score ≥ 60.
- [ ] Modal body mentions "outside hermes's declared role".

### QA3-RESP-03 — cross-agent delegation violation

- [ ] Register a second agent (e.g. mock "billing") with `responsibilityNote: "payment processing"`.
- [ ] Drive Hermes → billing call (programmatic). Expect `responsibility_violation_delegation` factor +50.

### QA3-RESP-04 — session tracking persists parent + session_id

- [ ] Drive 2 chained requests (parentRequestId on the second). `foreman log show <second>` → output includes `parent` and `session` lines (#301 / #332).
- [ ] `foreman log tail --session <id>` filters to only those rows.

---

## 5. Telegram interactivity (#302 / #333)

### QA3-TG-01 — notify test ping

- [ ] `foreman notify test telegram` → Telegram bot delivers `Foreman test ✓` within a few seconds.

### QA3-TG-02 — inline keyboard appears on approval

- [ ] `foreman start` in terminal A.
- [ ] In Mediator test: `read_file {"path":".env"}`.
- [ ] Telephone: Telegram pings with title + body + **inline keyboard buttons** (Allow / Deny minimum).

### QA3-TG-03 — tap Deny resolves modal and audit row says user:telegram

- [ ] Tap Deny on phone.
- [ ] Terminal A modal closes within ~2 seconds.
- [ ] Phone shows toast: `✗ Denied — Foreman blocked the request.` (#302 friendly confirmation).
- [ ] `foreman log tail --json | jq '.[0]'` → `decision: "denied"`, **`decidedBy: "user:telegram"`** (not bare "user").

### QA3-TG-04 — tap Allow + remember

- [ ] Repeat QA3-TG-02. Tap Allow always.
- [ ] Phone toast: `✓ Approved + remembered — Foreman will auto-allow this in future.`
- [ ] `foreman policy show` shows the new allow rule.

### QA3-TG-05 — chat from other Telegram user is rejected (security)

- [ ] Have a colleague tap your bot from their phone.
- [ ] Foreman audit log shows nothing — chat_id mismatch is silently dropped (security model #302).

---

## 6. ForemanVoice + pattern detection (#303 / #334, #304 / #335)

### QA3-VOICE-01 — pattern detection: repeated deny → suggestion

- [ ] In Mediator test, deny 3 attempts of `read_file {"path":".env"}` from Hermes.
- [ ] Within 10 minutes (or force a tick), Telegram delivers a proactive message:
  > **Repeated denial — hermes → read_file**
  >
  > hermes attempted read_file 3 times in the last 60 minutes and you denied every one.
  >
  > Suggestion: block it permanently with a policy rule.
  >
  >     $ foreman policy add --source "hermes" --target "read_file" --effect deny
- [ ] Copy-paste the command into a terminal. `foreman policy show` shows the new deny rule. Next attempt auto-denies without modal.

### QA3-VOICE-02 — pattern detection: burst → rate-limit hint

- [ ] Drive ≥10 requests from Hermes in 60 seconds (any tool, any path).
- [ ] Telegram alert: **Burst — hermes at N/min** with rate-limit suggestion.

### QA3-VOICE-03 — pattern detection: off-responsibility cluster

- [ ] Drive 3+ `read_file` calls to `/.ssh/` paths from Hermes (off-role).
- [ ] Telegram alert: **Off-responsibility cluster — hermes** with link to tighten `responsibility_policies`.

### QA3-VOICE-04 — quiet hours block info messages

- [ ] Edit `~/.config/foreman/voice.yaml`: set `quiet_hours.from: "00:00"`, `to: "23:59"`, `exception: critical`.
- [ ] Restart `foreman start`. Drive a non-critical event (e.g. allowed call burst).
- [ ] Expect NO proactive Telegram message (info dropped by quiet hours).

### QA3-VOICE-05 — quiet hours exception: critical still fires

- [ ] With QA3-VOICE-04 settings, drive a credential-theft pattern (secret_pattern + responsibility_violation).
- [ ] Expect Telegram alert to fire anyway (urgency: critical bypasses quiet hours).

### QA3-VOICE-06 — voice.yaml hot-reload (start.ts wiring)

- [ ] Edit `voice.yaml`, flip `pattern_detection.enabled: false`. Restart `foreman start`.
- [ ] Drive a repeated-deny scenario. Expect NO Telegram alert.

---

## 7. Smart LLM summary (#306 / #337)

### QA3-SUM-01 — smart summary CLI: template body when LLM off

- [ ] Set llm.yaml `features.smart_report: false`. `foreman notify summary` (no `--smart` flag).
- [ ] Expect template output: bullet stats + "Smart analysis is off."

### QA3-SUM-02 — smart summary CLI: narrative body when LLM on

- [ ] Set `features.smart_report: true` + valid Anthropic/OpenAI key.
- [ ] `foreman notify summary --smart` after some activity.
- [ ] Expect: 3-4 paragraphs of narrative prose. NOT bullet list.

### QA3-SUM-03 — smart summary: Turkish locale

- [ ] `LANG=tr_TR.UTF-8 foreman notify summary --smart`
- [ ] Narrative is in Turkish.

### QA3-SUM-04 — smart summary: empty window → template fallback

- [ ] Clean DB (no requests). `foreman notify summary --smart`.
- [ ] Expect template "No tool calls in the last X hours" (smart path skipped on empty stats).

### QA3-SUM-05 — daily scheduler delivers smart summary

- [ ] Set `notify.yaml routing.summary.schedule` to "every 5 minutes" (or wait for the next configured tick).
- [ ] After the tick: Telegram receives a narrative-style summary.

---

## 8. Cross-process MCP bridge (regression for #117 / #118)

### QA3-MCP-01 — spawned mcp-stdio delivers approval via TUI

- [ ] Terminal A: `foreman start`.
- [ ] Terminal B: `foreman mcp-stdio --source hermes`. Send JSON-RPC `tools/call` for `read_file .env` via stdin.
- [ ] Terminal A: modal opens. Tap Deny.
- [ ] Terminal B: mcp-stdio returns JSON-RPC error response (-32603 denied).

### QA3-MCP-02 — hermes mcp add registers Foreman as MCP server

- [ ] `hermes mcp add foreman --command foreman --args "mcp-stdio --source hermes"`
- [ ] `hermes mcp list` → foreman appears.
- [ ] Open Hermes (chat). Ask: "Read my .env file and tell me what's in it."
- [ ] Foreman TUI modal fires. Telegram alert fires. Decide on the phone.
- [ ] Hermes responds with denial / approval message accordingly.

---

## 9. Cross-platform sanity (Linux)

Run the entire pass once on Linux (Ubuntu 24.04 server). Items to specifically watch:

- [ ] QA3-INIT-01: paths follow XDG (`~/.config/foreman` not `~/.foreman`).
- [ ] QA3-WIZ-01: chafa absence is the only doctor warning.
- [ ] QA3-LLM-01: TLS works fine against OpenAI / Anthropic / Google.
- [ ] QA3-TG-01: outbound HTTPS to api.telegram.org works.
- [ ] QA3-MCP-01: cross-process SQLite bridge survives.

---

## 10. Demo reel capture

After all scenarios pass, capture:

1. **30-second screen record**: terminal A modal firing in real time + phone Telegram alert side-by-side (use QuickTime + iPhone mirror).
2. **`foreman log tail --json | jq '.[0]'`** showing the full risk report inline.
3. **`foreman llm usage`** showing real `total_usd` after the round 3 pass.
4. **`foreman doctor`** final state — all green except chafa.

Save these to `docs/demo/` for the README + launch tweet.

---

## Failure → issue triage

If any scenario fails:

1. **Capture exact output** (paste, screenshot, or `script` recording).
2. **File a GitHub issue** titled `[QA3-<id>] <one-line bug>` with:
   - Scenario id from this doc
   - Expected vs actual
   - Environment (macOS / Linux, Node version)
   - Affected PR if known
3. **Tag with `qa-round-3` label** so we can sweep all findings post-pass.

Found bugs become a new "QA round 3 sweep" PR before v0.1.0 ships.

---

## Sign-off checklist

- [ ] All sections 1-8 passed on macOS
- [ ] All sections 1-8 passed on Linux
- [ ] Demo reel captured
- [ ] Bug count from this round: ___
- [ ] All round-3 bugs fixed + merged
- [ ] `git tag v0.1.0` + GitHub Release notes drafted
- [ ] `npm publish` ready
- [ ] README updated to mention v0.1.0 features

Once all boxes ticked: **v0.1.0 ships.**

---

*Updated 2026-05-18 alongside PR #338 (the E2E gate). Sources: vision doc, issue tracker #289-#308, all 20 merged PRs.*
