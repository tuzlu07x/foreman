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

Hosted servers that use the MCP OAuth flow (Linear, and the hosted
servers from Notion and Slack, for example):

```bash
foreman mcp add linear --url https://mcp.linear.app/mcp --oauth
foreman mcp login linear                 # sign in in your browser
```

See *OAuth servers* below.

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
- **`auth: oauth`** (remote servers only) makes the hub sign in with the MCP
  OAuth flow and attach the token itself. Don't set an `Authorization`
  header on such a server; the hub adds one.

## OAuth servers

Some hosted servers don't take a static token. They use the MCP
authorization flow, which is OAuth 2.1 with PKCE. Mark the server with
`auth: oauth` (or add it with `--oauth`), then sign in once:

```yaml
servers:
  linear:
    url: https://mcp.linear.app/mcp
    auth: oauth
```

```bash
foreman mcp login linear            # prints the sign-in URL and opens it in a browser if it can
foreman mcp list                    # linear … oauth: logged in · expires in 59m
foreman mcp logout linear           # delete the stored tokens
```

`foreman mcp login` does the following:

1. It finds the server's authorization server from the server's
   protected-resource metadata (RFC 9728) and the authorization server's
   own metadata (RFC 8414).
2. It registers Foreman as a client (dynamic client registration,
   RFC 7591).
3. It starts a one-shot listener on `127.0.0.1` with a random port and
   prints the authorization URL. The URL carries a PKCE S256 challenge and
   a random `state`.
4. It exchanges the code the browser brings back for tokens.

Options: `--scope "<scopes>"` (the default is what the server advertises),
`--no-browser` (only print the URL; this is also automatic over SSH and
without a display), and `--timeout <seconds>` (default 300).

Once you're signed in, the hub keeps the session working by itself:

- The token is refreshed shortly before it expires. If the server rejects
  a token with 401, the hub refreshes it once and retries the request.
- When the server rotates refresh tokens, the new access and refresh
  tokens are saved together in one write before they are used. Agents
  each run their own `foreman mcp-stdio`, so these processes take turns
  (a lock file in the state directory). A refresh token is never sent
  twice.
- If a refresh is refused, or `url` in `mcp.yaml` changes, the server
  stays offline. `foreman mcp list` and `foreman doctor` then show *needs
  login*.

Security:

- Tokens are kept in the encrypted secret store as `mcp-oauth-<name>`.
  They never appear in `mcp.yaml`, in `foreman mcp list` or `doctor`
  output, in errors or in the audit log. Error text from the upstream or
  the authorization server is scrubbed of token values before it's shown.
- Agents never see the tokens. Only the hub process attaches them, on its
  own connection and after mediation. `secrets/get` refuses every
  `mcp-oauth-*` name whatever `policy.yaml` says, and `mcp.yaml` can't
  reference those names with `${secret:…}`.
- A token is only ever sent to the origin of the URL it was issued for.
- The redirect listener binds `127.0.0.1` only. It accepts a single
  callback, checks `state` (and `iss` when the server sends it), and times
  out.
- Foreman refuses any authorization, token or registration endpoint that
  isn't https, except for loopback addresses. It also refuses an
  authorization server that doesn't advertise PKCE S256, and protected-
  resource metadata that names a different server. Requests that carry a
  code or a token never follow redirects.

`foreman mcp logout` deletes the local tokens only. To revoke Foreman's
access completely, also remove the app in the provider's settings.

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
| `foreman mcp add <id> [args…]` | Add from the catalog, or `--command` / `--url` for your own (`--oauth` for MCP OAuth) |
| `foreman mcp list` | Configured servers, missing secrets, OAuth status |
| `foreman mcp login <name> [--scope s] [--no-browser] [--timeout sec]` | Sign in to an `auth: oauth` server |
| `foreman mcp logout <name>` | Delete a server's stored OAuth tokens |
| `foreman mcp tools [name] [--refresh]` | Connect, list tools, scan findings, token cost |
| `foreman mcp trust <name> [--include-flagged]` | Accept current definitions (after an update) |
| `foreman mcp enable / disable / remove <name>` | |
| `foreman mcp mode auto\|eager\|lazy` | Discovery mode |

## Limits and roadmap

- OAuth servers must support dynamic client registration. Servers that
  only accept pre-registered clients aren't supported yet.
- Each agent's `foreman mcp-stdio` runs its own copy of stdio servers
  (started lazily, reusing the pinned listing). A shared daemon is planned.
- Resources and prompts from upstream servers are not proxied yet — tools only.

## Troubleshooting

- **`unavailable — … timed out`** on first use: `npx` / `uvx` is downloading
  the package. Retry `foreman mcp tools <name> --refresh`; behind a proxy
  make sure `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS` are set (they are passed
  through to servers).
- **A tool disappeared**: `foreman mcp tools <name>` shows why (denied,
  quarantined, changed since pinned). A rug pull caught during a call is
  remembered, so it shows there even without `--refresh`; the call itself
  is logged as denied (`mcp:withheld:<server>`). `--refresh` compares with
  the live server, and `foreman mcp trust <name>` accepts the new version.
