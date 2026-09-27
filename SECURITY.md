# Security policy

Foreman sits on a security boundary between developer agents and their tools.
Please report suspected vulnerabilities privately rather than opening a public
issue.

## Reporting a vulnerability

Open a private [GitHub security advisory](https://github.com/tuzlu07x/foreman/security/advisories/new).
Include a clear description, affected version, impact, reproduction steps, and
a minimal proof of concept. Remove credentials, tokens, private keys, and
personal data before submitting.

Please do not disclose the issue publicly until a maintainer has had a
reasonable opportunity to investigate and publish a fix or mitigation; we will
agree on a disclosure timeline with you.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` / latest release | ✅ |
| older releases | ❌ — upgrade with `npm install -g foreman-agent@latest` |

Foreman requires Node.js 22.12+; Node 20 is end-of-life and unsupported.

## Scope

Reports are especially valuable for weaknesses that could bypass or weaken
policy enforcement, approval routing, agent identity, secret protections,
audit integrity, MCP hub mediation (tool pinning, poisoning scan, result
guard), org-chart delegation rules, installation, releases, or bundled
integration configuration.

## Threat model in brief

Foreman defends against **agents that were tricked or went wrong**: prompt
injection from web pages, emails, tool descriptions or tool results;
destructive commands; secret exfiltration; poisoned or silently changed MCP
tools; and runaway delegation between agents. It does so before execution,
and it fails closed:

- Claude Code hook errors block the call.
- Adapter decode errors deny the call.
- Invalid policy patterns never widen a rule.
- A broken `org.yaml` blocks delegation.

Known limits, which we track as roadmap items rather than hide:

- **Same OS user.** Agents run as you, so an agent with unrestricted shell
  access can in principle read Foreman's files. The tamper-protection rule
  flags any such access as critical, and files are owner-only. True
  isolation needs a separate OS user or keychain, which is planned.
- **Self-declared agent ids.** `--source` identifies an agent on the MCP
  path. Per-agent identity tokens are planned. Blocked and paused agents
  are denied on every transport today.
- **Relayed approvals.** By default, Telegram decisions reach Foreman
  through the chat agent that polls the bot. Each allow button carries an
  HMAC tag bound to that action. Other agents can't approve anything, and
  the chat agent can't approve before you tap, because allow tokens never
  appear in the message text. But once you tap *any* button on a message,
  Telegram hands the chat agent the whole keyboard, so against a
  compromised chat agent the tags are defence in depth only.
  **Close this with the approval bot** (`foreman notify approval-bot`): a
  second bot that only Foreman holds and polls. Approvals then never pass
  through an agent. Push-only channels (Slack, Discord, email, ntfy) never
  carry approval tokens. In two-way mode (`foreman notify
  slack-interactive` / `discord-interactive`), Slack and Discord buttons
  reach Foreman over a Socket Mode / Gateway connection only Foreman holds.
  Only the configured user ids can act, and each button is HMAC-tagged
  with a key separate from relay tokens, so button values readable in chat
  history can't be replayed through `submit_approval`.
  Commands typed there run as the owner, like the TUI, and are audited.
- **Pre-execution only.** Foreman decides before a call runs; it does not
  roll back side effects of calls you approved.
