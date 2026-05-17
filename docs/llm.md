# Optional LLM features (#230 — C7)

How Foreman uses a model to verify heuristic flags, generate smart reports, and (later) propose policy rules. **Opt-in, kill-switched, budgeted.** Foreman ships with LLM features off by default — you turn them on when you want them and you pay for them out of your own API budget.

This doc covers the **C7-1 foundation slice**: config, Anthropic client, budget tracker, CLI. C8 (verification consumer) and C9 (smart report consumer) are separate issues.

---

## 1. The pitch

Heuristic detection (C1–C6) is fast, free, and false-positive-prone — a paraphrased prompt-injection or a base64-encoded shell payload slips past regex. An LLM call can read context and decide *"is this actually phishing?"* without coding every variation into a pattern.

Foreman keeps this **opt-in** because (a) it costs money, (b) it adds latency, (c) some users don't want their tool args sent to a third-party model. When you turn it on, every call is logged with cost so you can see what it's spending.

---

## 2. `~/.foreman/llm.yaml` config

```yaml
enabled: false                  # global kill-switch
provider: anthropic             # which provider Foreman calls
model: claude-haiku-4-5-20251001 # cheapest current Claude

features:
  verification: false           # C8 — second-opinion on heuristic-flagged calls
  smart_report: false           # C9 — human-readable approval narratives
  policy_suggestions: false     # future — propose rule changes from audit log

budget:
  monthly_cap_usd: 5.00         # hard ceiling — Foreman refuses calls when exceeded
  alert_threshold_pct: 80       # alert when 80% of cap is spent
  reset_day_of_month: 1         # billing window rolls over on the 1st

credentials:
  anthropic:
    secret_name: anthropic-key  # foreman secrets add anthropic-key
  openai:
    secret_name: openai-key
  gemini:
    secret_name: gemini-key
  ollama:
    endpoint: http://localhost:11434
    secret_name: null           # local — no key
  openai_compatible:
    endpoint_secret: openai-compatible-endpoint
    key_secret: openai-compatible-api-key
```

**No literal API keys ever live in this file.** Everything is a secret-store reference. Read by `loadLlmConfig()` with Zod-validated defaults; missing keys are filled in from `defaultLlmConfig()`.

---

## 3. Setup (Anthropic — the only provider in this PR)

1. Get a key: [console.anthropic.com](https://console.anthropic.com/) → API Keys
2. Store it:
   ```bash
   foreman secrets add anthropic-key
   # paste the key, hit Enter
   ```
3. Flip the global switch on:
   ```bash
   foreman llm enable
   ```
4. Enable the features you want:
   ```bash
   foreman llm enable verification
   foreman llm enable smart_report
   ```
5. Smoke-test:
   ```bash
   foreman llm test
   ```

   Expected output:
   ```
   ✓ anthropic responded in 487ms
     reply      pong
     tokens     in=8 out=4
     cost       $0.000028
   ```

Other providers (OpenAI / Gemini / Ollama / OpenAI-compatible) ship in **C7-2** — config schema already supports them; clients land alongside C8 when their use case lights up.

---

## 4. CLI

```bash
foreman llm status                       # global + provider + budget + per-feature flags
foreman llm enable                       # global switch on
foreman llm enable <feature>             # verification / smart_report / policy_suggestions
foreman llm disable
foreman llm disable <feature>

foreman llm test                         # cheap round-trip against the configured provider
foreman llm budget                       # detailed status (window, spent, remaining)
foreman llm budget --set 10              # change the monthly cap
foreman llm budget --alert 90            # alert at 90% instead of 80%
foreman llm budget --reset-day 15        # roll over on the 15th instead of 1st
foreman llm usage                        # last 30 calls — cost, feature, tokens, duration
foreman llm usage --limit 100 --json
```

`status` example:

```
Foreman LLM features

  global              ✓ enabled
  provider            anthropic (claude-haiku-4-5-20251001)
  budget              $0.32 / $5.00 (6%) — resets in 18 days

  Features:
    verification         ✓ on
    smart_report         ✓ on
    policy_suggestions   off
```

---

## 5. Budget tracker

Every `LlmClient.call()` writes a row to `llm_usage`:

| Column | Meaning |
|---|---|
| `id` | ULID |
| `ts` | Wall-clock ms |
| `provider` / `model` | What was called |
| `feature` | Which feature triggered it (`verification` / `smart_report` / `test`) |
| `input_tokens` / `output_tokens` | From the provider's response |
| `cost_usd` | Computed from a per-model pricing table |
| `request_id` | Link to `requests.id` when the call is about a specific tool call |
| `duration_ms` | Wall-clock latency |
| `cache_hit` | 1 when served from local cache (cost_usd = 0) |

**`assertBudget(db, config)`** is called by C8/C9 right before invoking the LLM — throws `LlmBudgetExceededError` when the cumulative cost in the current window crosses the cap. The cap is a HARD STOP; alerts trip at the percentage threshold but don't block calls.

**Billing window** wraps month-to-month using `reset_day_of_month`. With `reset_day=1` and today's date being June 15, the window is `June 1 → July 1`. With `reset_day=15` and today being June 10 (before reset), the window is `May 15 → June 15`.

---

## 6. Cost transparency

Pricing is hardcoded per model (refresh quarterly as Anthropic updates [pricing](https://www.anthropic.com/pricing)). Current table:

| Model | Input ($/MTok) | Output ($/MTok) |
|---|---|---|
| claude-haiku-4-5 (default) | $1 | $5 |
| claude-sonnet-4-6 | $3 | $15 |
| claude-opus-4-7 | $15 | $75 |

A typical verification call: ~500 input + ~100 output tokens = $0.001 with Haiku. At a $5/month cap, that's ~5,000 verifications per month.

Unknown models (a future Claude release before we update the table) fall back to **Haiku pricing as a conservative floor** so we never silently under-bill.

---

## 7. Security model

| Threat | Mitigation |
|---|---|
| **Leaked API key** in config | Keys live in Foreman's encrypted secret store (AES-256-GCM at rest). `llm.yaml` only carries a **reference** to the secret name. |
| **Cost runaway** | Hard `monthly_cap_usd` ceiling. `assertBudget()` throws before every call. Alert at `alert_threshold_pct`. |
| **Sensitive args leaked to provider** | Verification + smart-report consumers (C8/C9) decide what to send. v0.1 sends only the factor list + tool name; raw args go to the LLM only when the user opts in via `smart_report.include_args: true` (deferred to C9). |
| **Provider downtime** | `LlmProviderError` bubbles up; consumers can fall back to heuristic-only behavior (current default — no LLM calls at all). |

---

## 8. Sub-issue plan (C7 → C10)

| Issue | Scope | Status |
|---|---|---|
| **C7-1** (this PR) | Foundation: config + Anthropic client + budget + CLI + migration + doctor | shipped |
| C7-2 | OpenAI / Gemini / Ollama / OpenAI-compatible clients + wizard Step 5 | follow-up |
| C8 #231 | Verification consumer — second-opinion on heuristic-flagged calls | next |
| C9 #232 | Smart report consumer — three-layer human-readable approval modal | follow-up |
| C10 #233 | Budget alerts pushed via OOB notifications (uses `routing.budget_alert` from #235) | follow-up |

---

## 9. How it composes with C11

When `notify.yaml`'s `routing.budget_alert` route is non-empty, **C10** will push the alert through `NotificationService` so the user gets a Telegram message when LLM spend crosses the threshold. The notification infrastructure (C11a-1 / a-2 / b-1 / c) is already in place; C10 just wires the publisher.

The **SmartReport** from C9 will become the `body` of `critical` and `warning` notifications when LLM is enabled — current honest-fallback templates stay for users running heuristic-only.

---

## 10. Verification flow (C8 — this PR)

When `features.verification: true` AND credentials resolve, the mediator runs every flagged call through the LLM **before** opening the approval modal.

### Gating order

```
1. feature_disabled?   → return {skipped: 'feature_disabled', ...heuristic}
2. score < threshold?  → return {skipped: 'below_threshold', ...heuristic}
3. budget exhausted?   → return {skipped: 'budget_exhausted', ...heuristic}
4. cache hit?          → return cached verdict (cost = 0)
5. call LLM            → parse + cache + record_usage + return
```

Default threshold = **30** (medium-bucket floor). Anything below is low-confidence heuristic noise — no point asking the LLM about a 10-point call.

### Prompt template

The verifier sends a structured prompt with:
- Source agent + responsibility note
- Target agent + tool + JSON args
- Heuristic factors with signs + points + reasons
- Recent session activity (last 3 calls, relative time)
- Optional external trigger (C9 will populate when content is available)

…and asks for **strict JSON output**:

```json
{
  "is_real_threat": true,
  "threat_type": "credential_theft",
  "confidence": 0.92,
  "explanation_short": "Phishing email + .env read = textbook theft",
  "explanation_long": "Hermes received an email asking for API credentials and is now requesting .env from Claude Code. The agent has no business reading credentials for the user's pattern of work.",
  "recommended_action": "deny",
  "additional_risk_score": 15,
  "user_should_check": [
    "Sender of the triggering email",
    "Recent emails from same domain"
  ]
}
```

8 threat types: `prompt_injection`, `data_exfil`, `privilege_escalation`, `credential_theft`, `loop_attack`, `social_engineering`, `false_positive`, `user_initiated_legitimate`.

### Combining heuristic + LLM

```ts
function combineAssessment(heuristic, llm) {
  if (!llm || llm.skipped) return heuristic
  const adjustedScore = clamp(heuristic.totalScore + llm.additional_risk_score, 0, 100)
  const recommendation =
    llm.confidence >= 0.7 ? llm.recommended_action : heuristic.recommendation
  return { ...heuristic, totalScore: adjustedScore, bucket: bucketFor(adjustedScore), recommendation, llmVerification: llm }
}
```

**Confidence ≥ 0.7** is the threshold for letting the LLM's recommendation override the heuristic's. Below that, the LLM verdict is informational (shows in the modal) but doesn't change the gate.

`additional_risk_score` (−30..+30) always adjusts the bucket — small nudge, never enough to flip without correlation with confidence.

### Cache

Identical patterns within 5 minutes reuse the prior verdict — no extra LLM calls. Cache key: SHA-256 of `source.target.tool + canonical(args) + sorted(factor_ids)`. LRU-bound at 256 entries. Eviction is least-recently-used.

`canonical(args)` sorts every nested object's keys so `{a:1, b:2}` and `{b:2, a:1}` hash identically. The same logical request always lands on the same key regardless of how the agent serialised it.

### Graceful degradation

Every failure mode returns a `skipped` shell rather than throwing — the mediator continues with the heuristic-only assessment:

| Reason | When |
|---|---|
| `feature_disabled` | global off OR `features.verification: false` |
| `below_threshold` | heuristic score < verification threshold (default 30) |
| `budget_exhausted` | monthly cap reached — `assertBudget()` would throw |
| `llm_error` | provider HTTP error OR malformed JSON response |

Heuristic-only behavior is **identical** to running without verification — the modal still opens, factors render, user decides.

### Persistence

Every LLM call writes a `llm_usage` row (provider, model, tokens, cost, requestId, feature, latency, cache_hit). The verification verdict (including `skipped` reason) is persisted on the `requests.llm_verification` column as JSON. `foreman log show <id>` includes it in `--json` output.

### Performance

Latency target: **< 1s p95 for Haiku** on a typical 500-input/100-output verification. Cache hits return synchronously (~1µs). When the LLM is up, the round-trip dominates; when it's down, you'd notice via `skipped: llm_error` rows in `foreman llm usage`.

---

## 11. Sources

- [Anthropic Messages API docs](https://docs.anthropic.com/en/api/messages)
- [Anthropic pricing](https://www.anthropic.com/pricing) — refresh per release
- [OWASP — LLM06: Excessive Agency](https://owasp.org/www-project-top-10-for-large-language-model-applications/) — frames why opt-in matters
