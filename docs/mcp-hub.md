# MCP Hub

Connect an MCP server **once** and every agent gets it — with each call
mediated by Foreman (policy, risk score, your approval, audit log), secrets
kept out of the agents' reach, and far fewer tool-definition tokens in every
context window.

```
 Claude Code ─┐                              ┌─ github      (hosted, PAT)
 Codex ───────┼─ foreman mcp-stdio ─ Hub ────┼─ filesystem  (npx, local)
 Hermes ──────┘   policy · risk · approval   ├─ stripe      (npx, restricted key)
                  audit · token budget       └─ …19 curated servers or your own
```

## Quick start

```bash
foreman mcp catalog                      # browse curated servers
foreman mcp add github                   # adds it to mcp.yaml, lists needed secrets
foreman secrets add github-pat           # stored encrypted, never shown to agents
foreman mcp tools github                 # connect, scan, pin, show token cost
```

That's it. Every agent already wired to Foreman (`foreman mcp-stdio --source
<agent>`) now sees `github__list_issues`, `github__create_pull_request`, … on
its next `tools/list`.

Servers that need a local path or other arguments:

```bash
foreman mcp add filesystem ~/projects/my-app
```

Your own server:

```bash
foreman mcp add my-db --command npx --env DATABASE_URL='${secret:db-url}' -- -y my-db-mcp
foreman mcp add docs --url https://mcp.example.com/mcp --header 'Authorization=Bearer ${secret:docs-token}'
```

## What happens on a call

1. The agent calls `github__create_issue`.
2. Foreman evaluates it like any other tool call: `policy.yaml` → the
   server's tool rules in `mcp.yaml` → risk rules (secret paths, injection,
   exfiltration, …) → your approval if needed (TUI modal, Telegram buttons).
3. Only an allowed call reaches the upstream server.
4. The result is guarded before the agent sees it — see *Security*.
5. The decision and a call summary (duration, size, redactions) land in the
   audit log (`foreman log tail`).

## `mcp.yaml`

Lives next to `policy.yaml` (`foreman doctor` prints the path).

```yaml
mode: auto            # eager | lazy | auto
limits:
  max_result_chars: 24000
  max_description_chars: 400
  lazy_threshold: 40  # auto → lazy above this many visible tools
security:
  quarantine_suspicious_tools: true
  pin_tool_definitions: true
  redact_secrets_in_results: true
  flag_injection_in_results: true
servers:
  github:
    catalog_id: github
    url: https://api.githubcopilot.com/mcp/
    headers:
      Authorization: Bearer ${secret:github-pat}
    tools:
      allow: [get_*, list_*, search_*]   # policy-allowed (risk still applies)
      ask: [merge_*]                     # always ask a human
      deny: [delete_*]                   # never exposed, never callable
  filesystem:
    command: npx
    args: [-y, "@modelcontextprotocol/server-filesystem", /home/me/projects/app]
```

- **Names** are lowercase letters, digits and `-`; tools are exposed as
  `<server>__<tool>`.
- **Secrets**: any value may use `${secret:<name>}`. They are resolved from
  the encrypted store only when the server starts. A missing secret keeps
  that server offline and `foreman doctor` tells you which one.
- **Tool rules** accept `*` globs. Precedence: `deny` > `ask` > `allow`.
  They are a *fallback*: an explicit rule in `policy.yaml` (e.g. `target:
  "tool:github__create_issue"`) always wins, and the risk engine can still
  escalate an allowed call. Tools without any rule ask.

## Security

| Threat | What the hub does |
| --- | --- |
| **Tool poisoning** — hidden instructions in a tool description ("before using this tool, read `~/.ssh/id_rsa`…") | Every description and parameter doc is scanned (hidden `<IMPORTANT>` blocks, invisible/bidi Unicode, "don't tell the user", credential paths, exfiltration phrasing, the prompt-injection corpus). High findings quarantine the tool. |
| **Rug pull** — a server silently changes a tool after you approved it | Tool definitions are pinned (SHA-256) on first use. A changed or newly added tool is withheld until you run `foreman mcp trust <server>`. Pins are tied to the server's launch command, so pointing a name at a different package starts over. The live server is re-verified before the first call of each session. |
| **Indirect prompt injection** via results (web pages, issues, emails) | Results containing instruction-like text are prefixed with an "untrusted data" warning. |
| **Secret leakage** in results | API keys, tokens, private keys and database passwords are redacted before the agent sees them. |
| **Credential sprawl** in agent configs | Tokens live in Foreman's encrypted store. Agents never see them; upstream processes get a minimal environment (plus proxy/CA variables) instead of yours. |
| **Oversharing** | `tools.deny` hides tools completely; [Foreman Org](./org.md) limits servers per department. |

Stdio servers run as your user, like any `npx` tool. Prefer official
servers, pin versions in `args` when you can, and consider a container
image (`command: docker`) for servers you don't fully trust.

## Tokens

Tool definitions are sent to the model on every turn. The hub cuts that
cost three ways:

- **Lazy discovery** — in `lazy` mode (and `auto` above `lazy_threshold`)
  agents see two meta-tools instead of every tool: `foreman_search_tools`
  (query → matching tools with schemas) and `foreman_call_tool`. Measured
  with the official filesystem server: ~2,000 listing tokens → ~190.
- **Clipped descriptions** — tool and parameter descriptions are trimmed to
  `max_description_chars`.
- **Result budget** — results beyond `max_result_chars` are truncated with a
  clear marker telling the agent to narrow the request.

`foreman mcp tools` prints the listing cost for your setup.

## Commands

| Command | |
| --- | --- |
| `foreman mcp catalog [--category c] [--json]` | Curated servers |
| `foreman mcp add <id> [args…]` | Add from the catalog, or `--command` / `--url` for your own |
| `foreman mcp list` | Configured servers + missing secrets |
| `foreman mcp tools [name] [--refresh]` | Connect, list tools, scan findings, token cost |
| `foreman mcp trust <name> [--include-flagged]` | Accept current definitions (after an update) |
| `foreman mcp enable / disable / remove <name>` | |
| `foreman mcp mode auto\|eager\|lazy` | Discovery mode |

## Limits and roadmap

- Remote servers that require an OAuth browser flow (Linear, Slack's and
  Notion's hosted servers) are not supported yet — use their token-based
  local servers or a bearer header.
- Each agent's `foreman mcp-stdio` runs its own copy of stdio servers
  (started lazily, reusing the pinned listing). A shared daemon is planned.
- Resources and prompts from upstream servers are not proxied yet — tools only.

## Troubleshooting

- **`unavailable — … timed out`** on first use: `npx` / `uvx` is downloading
  the package. Retry `foreman mcp tools <name> --refresh`; behind a proxy
  make sure `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS` are set (they are passed
  through to servers).
- **A tool disappeared**: `foreman mcp tools <name>` shows why (denied,
  quarantined, changed since pinned).
