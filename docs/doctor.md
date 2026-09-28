# `foreman doctor` — environment + state diagnostics

`foreman doctor` checks the Foreman home, database, identity key, policy file and registered agents, plus the optional configs (`notify.yaml`, `llm.yaml`, `voice.yaml`, `mcp.yaml`, `org.yaml`), agent identity tokens, the agent CLIs Foreman launches, the update cache and a few optional extras such as `chafa`. It is safe to run repeatedly and doesn't change your configuration. The one file it may write is the secret store's master key, `secrets.key`, which it creates when it doesn't exist yet. If you have secrets stored and `secrets.key` has gone missing, restore it from a backup before running doctor: a new key can't decrypt them.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All checks passed. |
| `1` | One or more warnings (no failures). Examples: no agents registered yet, an agent CLI not on your PATH, the optional `chafa` missing. |
| `2` | One or more failures. Examples: corrupt database, missing identity key, FTS5 unavailable. |

The contract is deliberately permissive on exit code 1 — fresh installs warn rather than fail, so CI bootstrap scripts can run `foreman doctor` without their own status-parsing logic and tolerate the expected warnings.

## Output

### Human (default)

On a fresh Linux machine, right after `foreman init` (paths shortened to `~`; yours depend on the platform and on `FOREMAN_HOME`):

```
Foreman doctor

  ✓ node_version         Node 22.22.2
  ✓ paths                config=~/.config/foreman · state=~/.local/state/foreman · cache=~/.cache/foreman
  ✓ foreman_home         ~/.config/foreman
  ✓ expected_files       identity.key, policy.yaml, foreman.db present
  ✓ identity_key         ed25519:1ee8599e…
  ✓ database             ~/.local/state/foreman/foreman.db opens; schema is at the latest migration
  ✓ migrations           up to date (28 applied)
  ✓ fts5                 FTS5 available; requests_fts ready
  ✓ policy_yaml          parses and matches the policy schema
  ✓ notify_config        notify.yaml absent — OOB notifications disabled (the default)
  ✓ notify_channels      no notify.yaml
  ✓ llm_config           llm.yaml absent — LLM features disabled (the default)
  ✓ llm_credentials      llm.yaml absent — credentials not required
  ✓ llm_budget           llm.yaml absent — LLM features disabled
  ✓ secret_slots         no legacy duplicate slots
  ✓ voice_config         voice.yaml absent — using built-in defaults (quiet hours 23:00→08:00, summaries at 20:00, pattern detection on)
  ⚠ agents_registered    no agents registered yet
     → Add one with 'foreman agent add' or 'foreman registry list' to pick from the curated catalog.
  ✓ agent_tokens         no agents registered
  ⚠ acp:hermes           Hermes declares acp_command="hermes" but the binary is not on PATH
     → Install Hermes (see https://hermes-agent.nousresearch.com/) and confirm `hermes --version` works. Until then, `foreman write hermes ...` will fail.
  ⚠ acp:openclaw         OpenClaw declares acp_command="openclaw" but the binary is not on PATH
     → Install OpenClaw (see https://openclaw.ai/) and confirm `openclaw --version` works. Until then, `foreman write openclaw ...` will fail.
  ⚠ acp:zeroclaw         ZeroClaw declares acp_command="zeroclaw" but the binary is not on PATH
     → Install ZeroClaw (see https://github.com/zeroclaw-labs/zeroclaw) and confirm `zeroclaw --version` works. Until then, `foreman write zeroclaw ...` will fail.
  ✓ provider_mapping     no agents with provider_mapping registered
  ✓ mcp_gateway          gateway instantiates cleanly (stdio transport ready)
  ✓ mcp_hub              no mcp.yaml — MCP hub not configured (try `foreman mcp catalog`)
  ✓ org                  no org.yaml — agents work without an org chart (try `foreman org templates`)
  ✓ legacy_home          no legacy ~/.foreman/ files detected
  ✓ update               no cached check yet — 'foreman start' will refresh on next run
  ⚠ chafa                chafa not found
     → Optional: 'brew install chafa' (macOS) or 'apt install chafa' (Debian/Ubuntu) for the higher-fidelity boot mascot.

23 ok  ·  5 warning  (exit 1 — warnings only)
```

A few checks add a row per agent: the `acp:<id>` rows above, `agent_tokens:<id>` for an agent whose wiring doctor can't see, and `node_engines:<id>` when an agent needs a newer Node. The footer always names the exit code so you can match what you see to what your shell scripts will read.

### JSON (`--json`)

The same checks, in order (shortened here):

```json
{
  "checks": [
    {
      "name": "node_version",
      "status": "ok",
      "message": "Node 22.22.2"
    },
    {
      "name": "agents_registered",
      "status": "warn",
      "message": "no agents registered yet",
      "remediation": "Add one with 'foreman agent add' or 'foreman registry list' to pick from the curated catalog."
    },
    {
      "name": "chafa",
      "status": "warn",
      "message": "chafa not found",
      "remediation": "Optional: 'brew install chafa' (macOS) or 'apt install chafa' (Debian/Ubuntu) for the higher-fidelity boot mascot."
    }
  ],
  "summary": {
    "ok": 23,
    "warn": 5,
    "fail": 0
  },
  "exitCode": 1
}
```

`remediation` is present only on checks that have one. The `summary` field is the counts by status — drives CI thresholds without iterating `checks[]`.

## Common scenarios

**Fresh install:**
```
agents_registered    warn   no agents registered yet
acp:hermes           warn   Hermes declares acp_command="hermes" but the binary is not on PATH
acp:openclaw         warn   OpenClaw declares acp_command="openclaw" but the binary is not on PATH
acp:zeroclaw         warn   ZeroClaw declares acp_command="zeroclaw" but the binary is not on PATH
chafa                warn   chafa not found
(exit 1 — warnings only)
```
Expected. Run `foreman setup` (the wizard) or `foreman agent add` to register the first agent. The `acp:*` rows cover every ACP agent in the bundled catalog, registered or not: each one warns until that agent's CLI is on your PATH, so you can ignore the ones for agents you don't use.

**Legacy home:**
```
legacy_home          warn   legacy ~/.foreman/ still contains config or state files
```
An install from before the platform-native layout left files in `~/.foreman/`. Run `foreman migrate-config` to move them. The check looks at `~/.foreman/` even when `FOREMAN_HOME` is set, so if you set `FOREMAN_HOME=~/.foreman` on purpose, this warning is about your live home: don't run `migrate-config` in that case.

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

## The update check

Doctor itself doesn't go online. `foreman start` asks the npm registry for the latest `foreman-agent` version at most once a day and caches the answer (`version-check.json` in Foreman's cache dir), and the `update` check reads that cache: `no cached check yet` until `foreman start` has run, then `up to date (latest …)` or a warning with the upgrade command. To turn the lookup off (offline or air-gapped machines), set `FOREMAN_NO_UPDATE_CHECK=1`; the check then reports `ok` with a "skipped" message.
