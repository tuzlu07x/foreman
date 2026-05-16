# Foreman detection — factor model & rule library

How Foreman decides whether a tool call is risky. Read this before tweaking [`src/core/risk-rules/`](../src/core/risk-rules/), `policy.yaml`'s `buckets:` block, or the approval modal rendering.

---

## 1. The factor model (C1, #224)

Every intercepted tool call runs through a stack of `RiskRule`s. Each rule inspects the call and returns **zero or more** `RiskFactor`s:

```ts
interface RiskFactor {
  rule: string        // stable id — e.g. "secret_path", "shell_destructive"
  category: RiskCategory  // secret | shell | network | injection | loop | structural
  points: number      // positive raises score; negative subtracts (safe-list)
  reason: string      // one-line human description
  evidence?: string   // optional matched substring / fingerprint
}
```

The scorer ([`src/core/risk-scorer.ts`](../src/core/risk-scorer.ts)) sums points (clamped 0–100), classifies the score into a **bucket**, and resolves a **recommendation**:

| Bucket | Score range | Default recommendation | Modal border colour |
|---|---|---|---|
| `low` | 0–29 | `allow` (auto-allowed) | green |
| `medium` | 30–59 | `ask` | yellow |
| `high` | 60–84 | `ask` | orange |
| `critical` | 85–100 | `ask` | red |

The mediator gates on `recommendation`: `allow` falls through, `ask` opens the approval modal, `deny` short-circuits with `decidedBy: "risk:<bucket>"`.

### Why factors instead of one flat score

The TUI's approval modal renders factors **grouped by category** with per-factor reasons and evidence. The user sees *why* a call is risky in plain English — `🔒 Secret-related (+60 pts) — .env-style file (likely contains API keys / secrets)` — not just `risk: 80`. Detection layers (C8 LLM verification, C9 smart report) consume the structured factor list directly.

---

## 2. Default rules (v0.1)

Five rules ship in `DEFAULT_RISK_RULES`:

| Rule name | Category | Source file |
|---|---|---|
| `secret_pattern` | secret | [`secret-patterns.ts`](../src/core/risk-rules/secret-patterns.ts) |
| `outbound_network` | network | [`outbound-network.ts`](../src/core/risk-rules/outbound-network.ts) |
| `shell_exec` | shell | [`shell-exec.ts`](../src/core/risk-rules/shell-exec.ts) |
| `first_agent_to_agent` | structural | [`first-agent-to-agent.ts`](../src/core/risk-rules/first-agent-to-agent.ts) |
| `previously_denied_pattern` | structural | [`previously-denied-pattern.ts`](../src/core/risk-rules/previously-denied-pattern.ts) |

A rule's `name` identifies the rule in `DEFAULT_RISK_RULES`. The **factors** it emits carry their own `rule` field — `secret_pattern` emits factors with `rule: "secret_path"`, `"secret_shape"`, or `"safe_list_docs"`, so the UI can render each match type distinctly.

C2–C6 will land more rules (shell danger, exfil-host network, prompt injection, loop anomaly). They all follow the same `RiskRule` contract — no plumbing changes once #224 landed.

---

## 3. Secret pattern library (C2, #225)

The `secret_pattern` rule covers two families:

### Path patterns — 60+ well-known secret file paths

Organised into 8 categories. Each match emits a `secret_path` factor with category-appropriate points. Examples:

| Category | Sample paths | Points |
|---|---|---|
| Cloud / IaaS | `~/.aws/credentials`, `~/.kube/config`, `gcloud/application_default_credentials.json` | 40–70 |
| SSH + Git | `~/.ssh/id_*` (private), `*.pem`, `~/.netrc`, `~/.git-credentials` | 70–80 |
| Env / app config | `.env`, `.env.local`, Rails `config/master.key`, Azure `local.settings.json` | 50–80 |
| Package manager | `.npmrc`, `.yarnrc`, `.cargo/credentials.toml`, `.docker/config.json` | 50–70 |
| Password mgr / vault | 1Password CLI, Bitwarden, `.password-store`, macOS Keychain | 60–80 |
| Browser data | Chrome Login Data, Firefox `logins.json`, `key4.db`, cookie DBs | 60–80 |
| Foreman + partners | `identity.key`, `foreman.db`, `.hermes/.env`, `.codex/auth.json` | 60–80 |
| Misc certs | `*.pfx`, `*.p12`, `*.pem`, `*.kdbx`, `*.key`, `*.gpg` | 30–80 |

### Content shape patterns — 16 secret SHAPES inside args

Scans the JSON-stringified args for recognisable secret formats — fires a `secret_shape` factor at **60 pts** for each distinct type detected:

| Shape | Example |
|---|---|
| Anthropic API key | `sk-ant-api03-…` |
| OpenAI project / legacy keys | `sk-proj-…` / `sk-…` |
| AWS access key id / secret | `AKIA…` / `aws_secret_access_key = …` |
| GitHub PAT (classic / fine-grained / OAuth / Apps) | `ghp_…`, `github_pat_…`, `gho_…`, `ghs_…` |
| Slack bot / app tokens | `xoxb-…`, `xapp-…` |
| Telegram bot token | `<digits>:<AA…>` |
| JWT (3-part) | `eyJ…\.eyJ…\.…` |
| PEM private key | `-----BEGIN [RSA…] PRIVATE KEY-----` |
| Database URL with creds | `postgres://user:pass@host/db` |
| Google API key | `AIza…` |

**Redaction**: The reason string shows a `shortFingerprint(secret)` like `sk-ant-a…TAIL` — never the full value. The factor's `evidence` field holds only the secret type label (e.g. `"Anthropic API key"`), not the secret itself. The approval modal and audit log can both surface the factor without leaking the secret to disk or to the user.

### Safe-list — common docs / config files

Eleven patterns subtract `-10` when they'd otherwise trigger a false positive — `.envrc`, `.env.example`, `.env.sample`, `.gitignore`, `package.json`, `tsconfig*.json`, `README*`, `LICENSE`, `CHANGELOG`. The safe-list only fires when at least one positive factor is already present, so a benign `README.md` read doesn't pollute the inspect view with a `-10` factor.

### Sources

- [gitleaks rules](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) (MIT) — content regex library
- [GitHub secret-scanning patterns](https://docs.github.com/en/code-security/secret-scanning/secret-scanning-patterns)
- [OWASP — Sensitive Data Exposure](https://owasp.org/www-project-top-ten/2017/A3_2017-Sensitive_Data_Exposure)

---

## 4. Per-bucket overrides in `policy.yaml`

A top-level `buckets:` block lets the user pin recommendations differently from the defaults — useful once a deployment has measured its own false-positive rate:

```yaml
# ~/.foreman/policy.yaml

agents:
  hermes:
    can_call:
      claude-code: [read_file, list_files]

# Optional: override the default per-bucket recommendation
buckets:
  critical: deny   # auto-deny anything score 85+ without asking
  medium:   ask    # (default, explicit)
  high:     ask    # (default, explicit)
  low:      allow  # (default, explicit)
```

Read by [`PolicyEngine.getBucketOverrides()`](../src/core/policy-engine.ts) on every YAML reload; threaded into the scorer via the `bucketOverrides` callback so a hot reload takes effect without restarting `foreman start`. Confirm what's active with:

```bash
foreman policy show --json   # → { rules: [...], bucketOverrides: { critical: "deny" } }
foreman policy show          # → human view, prints a "bucket overrides:" footer
```

---

## 5. LLM verification slot (C8 — deferred to #231)

`RiskAssessment.llmVerification` is reserved for the C8 LLM layer:

```ts
interface LlmVerification {
  verdict: 'confirms' | 'overrides' | 'inconclusive'
  reason: string
  provider: string
  model: string
  durationMs: number
}
```

When `~/.foreman/llm.yaml` is configured (C7, #230), the mediator will optionally route high-bucket assessments through the LLM for second-opinion verification before opening the modal. The DB column already exists (`requests.llm_verification`); writes are gated on `~/.foreman/llm.yaml` being present.

Until C8 lands, the field is always `null`.

---

## 6. Extending detection

To add a new rule:

1. Create `src/core/risk-rules/<name>.ts` exporting a `RiskRule`.
2. Export it from `src/core/risk-rules/index.ts`.
3. Add it to `DEFAULT_RISK_RULES` in [`src/core/risk-scorer.ts`](../src/core/risk-scorer.ts).
4. Add a one-line entry to [`src/tui/reason-explanations.ts`](../src/tui/reason-explanations.ts) for each `rule` id the rule emits.
5. Land unit tests in `tests/core/risk-rules/<name>.test.ts` covering: every documented match (positive), every documented safe-list / non-match (negative), edge cases (empty args, unicode, 50 KB blob, malformed JSON), perf budget (`< 5 ms p95`).

Pattern sources should be cited in the rule file's header comment. Always include a perf benchmark — every new regex compounds the per-call work.
