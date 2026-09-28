# `foreman doctor` — environment + state diagnostics

`foreman doctor` runs a fixed set of checks against the Foreman home, database, identity key, policy file, agent registry, and a few optional environment bits (chafa, update cache). It is safe to run repeatedly — no check mutates state.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All checks passed. |
| `1` | One or more warnings (no failures). Examples: optional dependency missing (`chafa`), no agents registered yet on a fresh box. |
| `2` | One or more failures. Examples: corrupt database, missing identity key, FTS5 unavailable. |

The contract is deliberately permissive on exit code 1 — fresh installs warn rather than fail, so CI bootstrap scripts can run `foreman doctor` without their own status-parsing logic and tolerate the expected warnings.

## Output

### Human (default)

```
Foreman doctor

  ✓ node_version         Node 20.11.0
  ✓ paths                config=… · state=… · cache=…
  ✓ foreman_home         /Users/x/Library/Application Support/foreman
  ✓ expected_files       identity.key, policy.yaml, foreman.db present
  ✓ identity_key         ed25519:a392ca…
  ✓ database             … opens; schema is at the latest migration
  ✓ migrations           up to date (5 applied)
  ✓ fts5                 FTS5 available; requests_fts ready
  ✓ policy_yaml          parses
  ✓ agents_registered    1 registered (1 active)
  ✓ agent_tokens         1 agent proves its identity with a token
  ✓ mcp_gateway          gateway instantiates cleanly (stdio transport ready)
  ✓ legacy_home          no legacy ~/.foreman/ files detected
  ✓ update               up to date (latest 0.1.0)
  ⚠ chafa                chafa not found
     → Optional: 'brew install chafa' (macOS) or 'apt install chafa' (Debian/Ubuntu) for the higher-fidelity boot mascot.

13 ok  ·  1 warning  (exit 1 — warnings only)
```

Footer always names the exit code so you can match what you see to what your shell scripts will read.

### JSON (`--json`)

```json
{
  "checks": [
    { "name": "node_version", "status": "ok", "message": "Node 20.11.0" },
    { "name": "chafa", "status": "warn", "message": "chafa not found", "remediation": "Optional: 'brew install chafa' …" }
  ],
  "summary": { "ok": 13, "warn": 1, "fail": 0 },
  "exitCode": 1
}
```

The `summary` field is the counts by status — drives CI thresholds without iterating `checks[]`.

## Common scenarios

**Fresh install:**
```
agents_registered    warn   no agents registered yet
chafa                warn   chafa not found
(exit 1 — warnings only)
```
Expected. Run `foreman setup` (the wizard) or `foreman agent add` to register the first agent.

**Agents without an identity token** (an install from before #618, or a
custom agent never given one):
```
agent_tokens         warn   no identity token for claude-code, codex — their MCP calls run untrusted (no agent allow rules, org role or hub servers)
                            → Run `foreman agent rewire --all`, then restart the agents. …
(exit 1 — warnings only)
```
Until they are rewired, these agents' MCP calls run as `untrusted:<id>`. The
check also flags an agent whose config still wires Foreman without its current
token (for example after a rotation whose config write failed). See
[Agent identity tokens](agent-lifecycle.md#agent-identity-tokens).

**Agent wiring doctor can't see** (generic-mcp, or an agent wired through
`--config-path` or `--token-out`):
```
agent_tokens         ok     1 of 2 agents proves its identity with a token
agent_tokens:generic-mcp warn generic-mcp: token issued, wiring not visible to doctor — make sure its MCP client passes FOREMAN_AGENT_TOKEN (or FOREMAN_AGENT_TOKEN_FILE)
                            → Get its token with 'foreman agent rewire generic-mcp --token-out <file>' and set it as FOREMAN_AGENT_TOKEN …
```
Doctor counts an agent as proving its identity only when it has read the
agent's MCP wiring and found its current token there. An agent whose wiring
it can't read gets its own warning row instead; the warning stays as long
as the wiring is out of doctor's sight.

**Identity key corrupt:**
```
identity_key         fail   identity.key is 24 bytes (expected 32)
(exit 2 — action required)
```
Back up `identity.key`, delete it, run `foreman init`. The key is rotated — agents need re-pairing.

**FTS5 missing:**
```
fts5                 fail   requests_fts virtual table not present after migration
(exit 2 — action required)
```
The loaded `better-sqlite3` has no FTS5. Since better-sqlite3 13 the npm package ships prebuilt binaries that include FTS5 (there is no install-time build any more), so this usually means an unsupported platform or a hand-built copy. Reinstall Foreman with `npm install -g foreman-agent` on a [supported platform](install.md#supported-platforms).

**Agent needs a newer Node:**
```
node_engines:openclaw  warn   OpenClaw needs Node >=24.16.0 <25 || >=26.1.0; found v22.12.0 on PATH
(exit 1 — warnings only)
```
Shown only when the agent is registered or on PATH. Foreman itself is fine; OpenClaw won't start until the `node` on PATH is in that range. Switch Node (e.g. `nvm install 24`), or run OpenClaw's upstream installer yourself: `curl -fsSL https://openclaw.ai/install.sh | bash`.

## Using doctor from scripts

```bash
# Treat exit 1 as success too (warnings are fine for bootstrap):
foreman doctor; [ $? -le 1 ] && echo "good enough"

# Fail loudly on exit 2:
foreman doctor || { [ $? -ge 2 ] && exit 1; }

# Parse the summary for monitoring:
foreman doctor --json | jq '.summary.fail'
```

## Skipping the update check

The `update` check fetches from npm to determine if a newer Foreman is available. To skip it (offline / air-gapped boxes), set `FOREMAN_NO_UPDATE_CHECK=1`. The check reports `ok` with a "skipped" message in that mode.
