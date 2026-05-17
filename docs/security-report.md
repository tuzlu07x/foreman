# Smart Security Reports (#232 — C9)

How Foreman builds the **3-layer modal** you see when a tool call needs your approval. One payload, four sources, one rendering path.

This doc covers the C9 consumer slice: how a `SecurityReport` is generated, what each variant looks like, how the modal collapses the technical detail behind `[t]`, and how reports are persisted for log replay.

---

## 1. What you'll see in the modal

```
╔════════════════════════════════════════════════════════════════╗
║    ___                                              score 80/100║
║   (o.o)  🔴 LIKELY THREAT — Credential Theft (90%)              ║
║    \_/                                          foreman → deny  ║
║                                                                ║
║ hermes [personal assistant] wants claude-code to read_file .env║
║                                                                ║
║ What's happening:                                              ║
║   The agent appears to be reading a credential file. The .env   ║
║   path is conventionally where API keys and database passwords  ║
║   live.                                                        ║
║                                                                ║
║ Things to check:                                                ║
║     · Did you initiate this action just now?                    ║
║     · Is .env a real secret or a placeholder?                   ║
║                                                                ║
║ Press [t] for technical detail (1 factor, score 80/100).        ║
║ Smart analysis: contextual verification ran on this request.    ║
║ ──────────────────────────────────────────────────────────────  ║
║  [a]llow once [d]eny [i]nspect [t]echnical                      ║
║  [A]lways allow [D]eny always                                   ║
║                                                  ⏱ 42s left   ║
╚════════════════════════════════════════════════════════════════╝
```

Three layers, top-to-bottom:

1. **Verdict** — icon + severity label + score + Foreman's recommendation.
2. **Narrative** — what's happening, things to check, recommendation.
3. **Technical** — factors + score breakdown, **collapsed by default**; toggle with `[t]`.

Border colour mirrors severity (red/orange/yellow/green). The icon comes from the verdict:

| Icon | Severity                |
| ---- | ----------------------- |
| 🔴   | critical                |
| 🟠   | high / uncertain        |
| 🟡   | medium / likely_legit   |
| 🟢   | low                     |

---

## 2. Four variants — same shape, different source

Every modal renders the same struct, but the **footer** tells you how it was built. The variant is decided when the report is generated, based on whether C8 (LLM verification) ran:

| Source                | Footer                                                                         | When                                  |
| --------------------- | ------------------------------------------------------------------------------ | ------------------------------------- |
| `llm_verified`        | "Smart analysis: contextual verification ran on this request."                 | LLM responded                          |
| `llm_disabled`        | "Smart analysis is off. Run `foreman llm enable` for contextual reports."      | `features.smart_report = false`        |
| `llm_budget_exhausted`| "Smart analysis paused — monthly LLM budget exhausted. Resets next cycle."     | Budget tracker rejected the call       |
| `llm_failed_fallback` | "Smart analysis temporarily unavailable (provider error). Heuristic-only."    | LLM client threw                       |
| `heuristic_only`      | "Heuristic-only report. Run `foreman llm enable` for contextual analysis."    | Below verification threshold           |

Variants without an LLM verdict use **template narratives** (`src/core/narrative-templates.ts`) built from the heuristic factors. The templates are deliberately conservative — they never claim contextual insight Foreman doesn't have. The footer always points the user toward the richer report.

---

## 3. Where the report lives

- **Generated** in `src/core/security-report.ts` (`generateReport()`), right after `combineAssessment()` in the mediator.
- **Sent** with the `approval:requested` and `request:decided` events (`securityReport: SecurityReport | null`).
- **Persisted** to `requests.security_report` (added in migration `0010_security_report.sql`) by `AuditLogger`.
- **Re-rendered** from `foreman log show <id>` and the TUI log/sessions pages — `renderRequestDetail()` includes a `security report` block when present.

The cross-process bridge (`DbApprovalService`) only writes a minimal pending row; the rich report stays in-memory in the originating process. The legacy fallback modal renders if `request.securityReport` is `null`.

---

## 4. Verdict math

```ts
// LLM path:
if (llm.confidence < 0.7)            severity = 'uncertain'        // 🟠
else if (!llm.is_real_threat)        severity = 'likely_legitimate' // 🟡
else if (llm.recommended_action === 'deny')  severity = 'critical' // 🔴
else                                  severity = 'high'             // 🟠

// Heuristic-only path: severity = assessment.bucket
```

Confidence below 0.7 always renders as **uncertain**, regardless of how strong the LLM's recommendation was. Better to ask the user than ship a false certainty.

---

## 5. Inspecting / debugging

```bash
foreman log show <request-id>            # human-readable, includes security report block
foreman log show <request-id> --json     # full JSON, securityReport parsed back to object
```

In the TUI:

- Press `[t]` in the modal to expand/collapse the technical layer.
- Press `[i]` to drop into the inspect view (full arg dump + factor evidence).

---

## 6. Footguns

- **Don't fake an LLM verdict in tests.** Use `assessment.llmVerification = null` for heuristic-only paths and `{ skipped: 'feature_disabled' }` for the disabled variant. The generator uses `skipped` to pick the variant.
- **`SecurityReport` is required on `approval:requested` and `request:decided` events.** Cross-process bridges (db-approval) pass `null` — the modal falls back to the legacy view.
- **Heuristic confidence is a proxy**, not a real probability. The generator nudges it up with `totalScore / 200` so a 90-pt heuristic doesn't render with the same confidence as a 30-pt one.

---

## 7. Related issues

- #230 / C7 — LLM provider config + Anthropic client
- #231 / C8 — LLM verification consumer
- **#232 / C9 — Smart Report (this doc)**
- #233 / C10 — Budget alerts via OOB notifications
