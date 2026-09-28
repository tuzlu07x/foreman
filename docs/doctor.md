# `foreman doctor` — environment + state diagnostics

`foreman doctor` checks the Foreman home, database, identity key, secret store key, policy file and registered agents, plus the optional configs (`notify.yaml`, `llm.yaml`, `voice.yaml`, `mcp.yaml`, `org.yaml`), agent identity tokens, the CLIs of registered agents Foreman launches, the update cache and a few optional extras such as `chafa`. It is safe to run repeatedly and changes nothing: it creates no files (not even `secrets.key` or the database), never writes or removes a secret, and reads secrets without marking them accessed.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All checks passed. |
| `1` | One or more warnings (no failures). Examples: no agents registered yet, a registered agent's CLI not on your PATH, the optional `chafa` missing. |
| `2` | One or more failures. Examples: corrupt database, missing identity key, `secrets.key` missing while secrets are stored, a `policy.yaml` that doesn't load, FTS5 unavailable. |

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
  ✓ identity_key         ed25519:60b231f3…
  ✓ database             ~/.local/state/foreman/foreman.db opens; schema is at the latest migration
  ✓ secrets_key          present; no secrets stored yet
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
  ✓ acp-agents           no ACP-mediated agents registered
  ✓ provider_mapping     no agents with provider_mapping registered
  ✓ mcp_gateway          gateway instantiates cleanly (stdio transport ready)
  ✓ mcp_hub              no mcp.yaml — MCP hub not configured (try `foreman mcp catalog`)
  ✓ org                  no org.yaml — agents work without an org chart (try `foreman org templates`)
  ✓ legacy_home          no legacy ~/.foreman/ files detected
  ✓ update               no cached check yet — 'foreman start' will refresh on next run
  ⚠ chafa                chafa not found
     → Optional: 'brew install chafa' (macOS) or 'apt install chafa' (Debian/Ubuntu) for the higher-fidelity boot mascot.

25 ok  ·  2 warning  (exit 1 — warnings only)
```

A few checks add a row per agent once agents are registered: `acp:<id>` for each registered Hermes, OpenClaw or ZeroClaw (it warns while that agent's CLI isn't on your PATH), `agent_tokens:<id>` for an agent whose wiring doctor can't see, and `node_engines:<id>` when an agent needs a newer Node. The footer always names the exit code so you can match what you see to what your shell scripts will read.

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
    "ok": 25,
    "warn": 2,
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
chafa                warn   chafa not found
(exit 1 — warnings only)
```
Expected. Run `foreman setup` (the wizard) or `foreman agent add <registry-id>` to register the first agent.

**Legacy home:**
```
legacy_home          warn   legacy ~/.foreman/ still contains config or state files
                            → Run 'foreman migrate-config' to move them into the platform-native dirs.
```
An install from before the platform-native layout left files in `~/.foreman/`. Run `foreman migrate-config` to move them. If `~/.foreman/` is your live home (`FOREMAN_HOME=~/.foreman`), doctor doesn't warn, and `migrate-config` says "nothing to migrate".

**Secret store key missing:**
```
secrets_key          fail   secrets.key is missing — 1 stored secret can't be decrypted
                            → Restore secrets.key from your backup to ~/.config/foreman/secrets.key (mode 0600) before adding any secret: …
(exit 2 — action required)
```
Restore `secrets.key` from a backup before you add any secret: adding one would create a new key the stored secrets can't use. If it's lost for good, remove and re-add each secret, and run `foreman agent rewire --all` for the agents' identity tokens. With no secrets stored the check is ok (`present; no secrets stored yet`).

**Broken `policy.yaml`:**
```
policy_yaml          fail   ~/.config/foreman/policy.yaml failed to parse (line 63): rules.4.effect: Invalid enum value. Expected 'allow' | 'deny' | 'ask', received 'maybe'
(exit 2 — action required)
```
Fix the line it names. Until then `foreman start` and new `foreman mcp-stdio` connections refuse to run, and the Claude Code hook blocks every call; processes already running keep the last policy that loaded. See [How edits apply](policy.md#how-edits-apply).

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
