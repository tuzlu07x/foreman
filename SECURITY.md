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

| Version                 | Supported                                               |
| ----------------------- | ------------------------------------------------------- |
| `main` / latest release | ✅                                                      |
| older releases          | ❌ — upgrade with `npm install -g foreman-agent@latest` |

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
- A broken `org.yaml` blocks delegation and every MCP hub server.
- A broken `mcp.yaml` leaves no MCP hub servers; changes to either file
  reach running agents without a restart, and a call approved after its
  server was disabled or the agent lost access never runs.
- Integration credentials are for the MCP hub only: no agent can read them
  through `secrets/get`, whatever the policy says, and they are never
  written into agent config files. `tools.confirm` tools (merges, pushes)
  need a person for every call.
- Integrations change from chat only on an owner surface (the TUI, the
  Telegram approval bot in your private chat, Slack / Discord from
  `owner_user_ids`); a relaying agent can only read them. Removing needs a
  single-use code bound to you and the integration; credentials are never
  taken in chat.

Known limits, which we track as roadmap items rather than hide:

- **Same OS user.** Agents run as you, so an agent with unrestricted shell
  access can in principle read Foreman's files. The tamper-protection rule
  flags any such access as critical, and files are owner-only. True
  isolation needs a separate OS user or keychain, which is planned.
- **Agent identity on the MCP path.** `--source` only names an agent; its
  identity token proves it. `foreman agent add` mints a 256-bit token,
  keeps it in the encrypted secret store under a name nothing agent-facing
  can read (`foreman secrets show` and the MCP `secrets/get` tool refuse
  it), and writes it into the agent's MCP config as the
  `FOREMAN_AGENT_TOKEN` env var, never as an argument. Files that carry it
  are owner-only. A connection with no token, a wrong one, or another
  agent's runs as `untrusted:<id>`: none of that agent's allow rules,
  nothing auto-allowed (`identity.untrusted` in `policy.yaml`: `ask` by
  default, or `deny` / `allow_wildcards`), no secrets, no org role, no delegation, no MCP hub servers, and no remembered "always
  allow". The claimed agent's deny and ask rules, block and pause still
  apply, so dropping the token never loosens anything. Tokens are
  compared in constant time, re-checked on every message (so
  `foreman agent token rotate` cuts off running sessions), and never
  printed, logged or audited. Installs from before tokens degrade to
  untrusted until `foreman agent rewire --all`; `foreman doctor` and
  `foreman start` say so. Token files are owner-only, never written
  through a symlink or into a project's git work tree, and `foreman doctor`
  flags any that others can read. Remaining limits: an agent running as
  the same OS user (see above) can read another agent's MCP config file,
  and so its token; tamper protection flags such a read (and any
  `/proc/*/environ` read) as critical, but a call that skips mediation
  isn't seen. `foreman mcp-stdio` deletes the token from its environment
  at start, so nothing it spawns inherits it, but Linux keeps the initial
  environment in `/proc/<pid>/environ`, readable by the same user. Agents
  that can instead point `FOREMAN_AGENT_TOKEN_FILE` at a 0600 file keep
  the token out of any process environment. `foreman write` from an agent's shell still trusts
  `FOREMAN_SPAWNED_BY`.
  Blocked and paused agents are denied on every transport.
- **Relayed approvals.** By default, Telegram decisions reach Foreman
  through the chat agent that polls the bot. Each allow button carries an
  HMAC tag bound to that action. Other agents can't approve anything, and
  the chat agent can't approve before you tap, because allow tokens never
  appear in the message text. But once you tap _any_ button on a message,
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
  A `/foreman` command relayed by an agent (`submit_command`) can't prove
  you typed it, and the `source_user` it carries is the agent's word, so
  only read-only verbs run at once. Handing out work (`write`, `assign`)
  runs as the agent's own delegation under the org chart, never as you.
  Anything else that changes Foreman (stop, model and LLM changes,
  sign-ins) waits for your OK on Foreman's own approval prompt (TUI or a
  tagged button) and is refused, and audited, otherwise.
- **Pre-execution only.** Foreman decides before a call runs; it does not
  roll back side effects of calls you approved.
