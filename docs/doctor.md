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
`better-sqlite3` was linked against a sqlite build without FTS5. `npm rebuild better-sqlite3` typically fixes it; if not, see the FTS5 troubleshooting note in `FOREMAN.md`.

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
