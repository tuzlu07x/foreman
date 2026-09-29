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

See _OAuth servers_ below.

## What happens on a call

1. The agent calls `github__create_issue`.
2. Foreman evaluates it like any other tool call: `policy.yaml` → the
   server's tool rules in `mcp.yaml` → risk rules (secret paths, injection,
   exfiltration, …) → your approval if needed (TUI modal, Telegram buttons).
3. Only an allowed call reaches the upstream server.
4. The result is guarded before the agent sees it — see _Security_.
5. The decision and a call summary (duration, size, redactions) land in the
   audit log (`foreman log tail`).

## `mcp.yaml`

Lives next to `policy.yaml` (`foreman doctor` prints the path).

```yaml
mode: auto # eager | lazy | auto
limits:
  max_result_chars: 24000
  max_description_chars: 400
  lazy_threshold: 40 # auto → lazy above this many visible tools
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
    access: # optional: who may use this server
      agents: [claude-code]
      departments: [engineering]
    tools:
      allow: [get_*, list_*, search_*] # policy-allowed (risk still applies)
      ask: [create_*] # ask a human unless policy.yaml allows it
      confirm: [merge_*] # a human confirms every single call
      deny: [delete_*] # never exposed, never callable
  filesystem:
    command: npx
    args: [-y, "@modelcontextprotocol/server-filesystem", /home/me/projects/app]
```

- **Names** are lowercase letters, digits and `-`; tools are exposed as
  `<server>__<tool>`.
- **Secrets**: any value may use `${secret:<name>}`. They are resolved from
  the encrypted store only when the server starts. A missing secret keeps
  that server offline and `foreman doctor` tells you which one.
- **Tool rules** accept `*` globs. Precedence: `deny` > `confirm` > `ask` >
  `allow`. They are a _fallback_: an explicit rule in `policy.yaml` (e.g.
  `target: "tool:github__create_issue"`) always wins, and the risk engine can
  still escalate an allowed call. Tools without any rule ask.
- **`confirm`** is stronger than `ask`: a person answers every call. No
  allow rule in `policy.yaml`, no remembered "always allow" and no low risk
  score can approve it; `policy.yaml` can still deny it.
- **`access`** limits a server to the listed agents and the members of the
  listed [departments](./org.md). Without it every verified agent may use
  the server; `access: {}` means nobody. It narrows what `org.yaml` allows,
  never widens it: an agent needs both.
- **Changes apply live.** A running `foreman mcp-stdio` re-reads `mcp.yaml`
  and `org.yaml` (at most once a second, and every 2 s while idle), tells
  the agent with `notifications/tools/list_changed`, and checks again right
  before an approved call runs: a server disabled, or an agent removed from
  its access list, while an approval was waiting never receives the call.
  A file that stops parsing leaves no hub servers at all until it is fixed.
- **Writes are locked.** `foreman mcp` commands take `mcp.yaml.lock`, write
  a temp file and rename it, and keep your comments.
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
foreman mcp logout linear           # delete the stored tokens (and revoke them if the server allows)
```

`foreman mcp login` does the following:

1. It finds the server's authorization server from the server's
   protected-resource metadata (RFC 9728) and the authorization server's
   own metadata (RFC 8414).
2. It registers Foreman as a client (dynamic client registration,
   RFC 7591).
3. It starts a one-shot listener on `127.0.0.1` with a random port and
   prints the authorization URL. The URL carries a PKCE S256 challenge, a
   random `state`, and the server's URL as the RFC 8707 `resource`, so
   the tokens are only valid for this server.
4. It exchanges the code the browser brings back for tokens.

Options:

- `--scope "<scopes>"`: the scopes to request. By default Foreman requests
  none, and the server grants its default access.
- `--no-browser`: only print the URL. This is also automatic over SSH and
  without a display.
- `--timeout <seconds>`: how long to wait for the sign-in (default 300,
  at most 1800).

Once you're signed in, the hub keeps the session working by itself:

- The token is refreshed shortly before it expires: a minute early, or
  halfway through its life for tokens that last under two minutes. If the
  server rejects a token with 401, the hub refreshes it once and retries
  the request.
- When the server rotates refresh tokens, the new access and refresh
  tokens are saved together in one write before they are used. Several
  processes can hold the session (the daemon, an agent's own
  `foreman mcp-stdio`, the `foreman mcp` commands), so they take turns
  (a lock file in the state directory). A refresh token is never sent
  twice.
- `login`, `logout` and `mcp remove` take the same lock. A refresh only
  replaces the session it started from, so a logout or a new login during
  a refresh is never undone. A running hub checks the stored session
  before every request, so it stops using a token as soon as you log out.
- If a refresh is refused, or `url` in `mcp.yaml` changes, the server
  stays offline. `foreman mcp list` and `foreman doctor` then show _needs
  login_.

Security:

- Tokens are kept in the encrypted secret store as `mcp-oauth-<name>`.
  They never appear in `mcp.yaml`, in `foreman mcp list` or `doctor`
  output, in errors or in the audit log. Error text from the upstream or
  the authorization server is scrubbed of token values before it's shown.
  So are tool results: if an upstream echoes the credential back, the
  agent sees `[REDACTED credential]`. This also applies to
  `${secret:…}` values of 8 characters or more.
- Agents never see the tokens. Only the hub process attaches them, on its
  own connection and after mediation. `secrets/get` refuses every
  `mcp-oauth-*` name whatever `policy.yaml` says, and `mcp.yaml` can't
  reference those names with `${secret:…}`.
- A token is only ever sent to the origin of the URL it was issued for.
- The redirect listener binds `127.0.0.1` only. It accepts a single
  callback, checks `state`, and times out. It also checks `iss`
  (RFC 9207), and requires it when the server says it sends it.
- Foreman refuses any authorization server, authorization, token,
  registration or revocation endpoint that isn't https, except for
  loopback addresses. It checks this before each request, including the
  token endpoint at every refresh. It also refuses an authorization
  server that doesn't advertise PKCE S256, metadata whose `issuer` isn't
  the authorization server (RFC 8414), and protected-resource metadata
  that names a different server.
- Requests that carry a code or a token never follow redirects. A
  redirect from the MCP server itself is refused, even to the same
  origin, rather than replayed with the bearer token.

`foreman mcp logout` deletes the local tokens. If the server has a
revocation endpoint (RFC 7009), it then asks the provider to revoke them
too. Revocation is best effort: logout succeeds even if the provider can't
be reached. To be sure Foreman's access is gone, also remove the app in
the provider's settings.

## Security

| Threat                                                                                                           | What the hub does                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tool poisoning** — hidden instructions in a tool description ("before using this tool, read `~/.ssh/id_rsa`…") | Every description and parameter doc is scanned (hidden `<IMPORTANT>` blocks, invisible/bidi Unicode, "don't tell the user", credential paths, exfiltration phrasing, the prompt-injection corpus). High findings quarantine the tool.                                                                                |
| **Rug pull** — a server silently changes a tool after you approved it                                            | Tool definitions are pinned (SHA-256) on first use. A changed or newly added tool is withheld until you run `foreman mcp trust <server>`. Pins are tied to the server's launch command, so pointing a name at a different package starts over. The live server is re-verified before the first call of each session. |
| **Indirect prompt injection** via results (web pages, issues, emails)                                            | Results containing instruction-like text are prefixed with an "untrusted data" warning.                                                                                                                                                                                                                              |
| **Secret leakage** in results                                                                                    | API keys, tokens, private keys and database passwords are redacted before the agent sees them.                                                                                                                                                                                                                       |
| **Credential sprawl** in agent configs                                                                           | Tokens live in Foreman's encrypted store. Agents never see them; upstream processes get a minimal environment (plus proxy/CA variables) instead of yours.                                                                                                                                                            |
| **Oversharing**                                                                                                  | `tools.deny` hides tools completely; `access` limits a server to named agents and departments, and [Foreman Org](./org.md) limits servers per department. Access changes reach running agents at once.                                                                                                               |
| **An agent reading an integration's credential**                                                                 | A secret an integration server references (a GitHub token, a Linear key) is for the hub only: `secrets/get` refuses it whatever `policy.yaml` says (`reserved:integration`), and it is never projected into an agent's config files.                                                                                 |
| **Borrowed identity** — a process claims another agent's `--source`                                              | Hub servers go only to agents that prove their id with their [identity token](./agent-lifecycle.md#agent-identity-tokens). An unverified `untrusted:<id>` connection sees no hub tools.                                                                                                                              |

Stdio servers run as your user, like any `npx` tool. Prefer official
servers, pin versions in `args` when you can, and consider a container
image (`command: docker`) for servers you don't fully trust.

## One daemon for every agent

While `foreman start` runs, it also runs Foreman's daemon. Every agent's
`foreman mcp-stdio` and Claude Code's PreToolUse hook (`foreman-hook`)
connect to it instead of starting Foreman on their own:

- **Each stdio server starts once**, for all agents, instead of once per
  agent. Scope stays per agent: each agent sees and calls only the servers
  its access list and `org.yaml` allow.
- **The hook answers in tens of milliseconds** instead of a few hundred:
  the daemon already has the policy, risk and approval stack loaded
  (`node scripts/hook-latency.mjs` measures it on your machine).

Nothing changes in what gets decided. The daemon runs the same code the
agent's own process would, on the same `policy.yaml`, `mcp.yaml`,
`org.yaml` and database. Approvals appear in the TUI and on your channels
as before, and `mcp.yaml` edits still reach connected agents live.

When the daemon isn't running (no `foreman start`, or you quit it), each
`foreman mcp-stdio` and hook call runs Foreman in its own process, as
before: slower, with the same decisions. `foreman daemon` runs the daemon
without the TUI, for machines where you don't keep the TUI open. Set
`FOREMAN_NO_DAEMON=1` in an agent's environment to keep it off the daemon.
`foreman doctor` shows whether agents can use it (the `daemon` row), and
the Inbox says why when `foreman start` couldn't start it.

### Run the daemon at login (`foreman service`)

To have the daemon, and your approvals in chat, without a terminal open,
install Foreman as a background service of your own user:

```bash
foreman service install     # start it now and at every login
foreman service status      # installed? running? what it runs, where it logs
foreman service uninstall   # stop it and remove the service file
```

- **macOS:** a LaunchAgent, `~/Library/LaunchAgents/dev.foreman.daemon.plist`,
  loaded with `launchctl bootstrap gui/<uid>` (`launchctl load -w` on older
  systems). launchd restarts it if it crashes. Its log is
  `<state dir>/daemon.log`.
- **Linux and WSL2:** a systemd user unit,
  `~/.config/systemd/user/foreman-daemon.service`, enabled and started with
  `systemctl --user enable --now`. It restarts on a crash and logs to the
  journal (`journalctl --user -u foreman-daemon.service`). It runs while you
  are logged in; `loginctl enable-linger` keeps it running without a
  session. Without systemd (common on WSL), `install` says so and changes
  nothing: run `foreman daemon` yourself, or turn systemd on in WSL
  (`[boot] systemd=true` in `/etc/wsl.conf`).
- **Native Windows:** not supported (there is no daemon there).

The service runs `foreman daemon --service` with the absolute paths of the
Node binary and the Foreman CLI you ran `install` with, never a PATH
lookup. It gets your `FOREMAN_HOME` when that is set, and your PATH (the
MCP hub's stdio servers are found on it); nothing else from your shell, so
proxy and CA variables set only in your shell don't reach the servers it
starts. **Run `foreman service install` again after upgrading Node or
Foreman, or moving either**: `status` warns when a path it runs is gone.
There is one service per user; installing again replaces it.

The files are yours: the service file is 0644 in your own directory, never
written through a symlink or outside your home directory, and the macOS log
is 0600. The daemon's socket, token and checks are the same as when
`foreman start` hosts it.

**What the service runs.** `foreman daemon --service` is the whole
headless gateway: the daemon, and everything else `foreman start` runs
besides the TUI. Approvals go to the channels routed in `notify.yaml`, and
your taps come back (the Telegram approval bot, Slack Socket Mode, the
Discord Gateway); `/foreman` commands from chat, schedules, the daily
digest and budget alerts run there too. A call that needs your OK reaches
your phone with no terminal open.

**With `foreman start`.** Exactly one gateway runs per Foreman home. When
the service is running, `foreman start` **attaches** to it: it runs the TUI
only, and the header says *attached*. Approvals
are kept in the database, so the TUI shows them and decides them; the
first answer wins, from the TUI or from chat, and the chat message is
updated to say so. Quitting the attached TUI leaves the service running.
When `foreman start` got there first, it runs the gateway itself and the
service waits, then takes over within a few seconds of `foreman start`
quitting. With neither running, nothing shows an approval: a call that
needs one waits until it times out and is denied (`foreman inbox` lists
what was missed). `foreman service status` and `foreman doctor` (the
`gateway` row) say which one runs it, and doctor says where approvals go.

A plain `foreman daemon` (without `--service`) still runs only the daemon;
a service started while one is listening runs the rest of the gateway and
takes the socket over when that daemon stops.

If the daemon can't start for a reason a restart won't fix (Foreman isn't
initialised, the state directory is open to other users), the service logs
why and stops instead of restarting in a loop. Fix it, then run
`foreman service install` again. `foreman doctor` warns when the service is
installed but the daemon isn't running, and when the gateway has stopped
checking in.

How it stays safe:

- **A Unix socket, never the network.** The socket is
  `<state dir>/foreman.sock`, readable and writable only by you (0600).
  There is no TCP listener. The daemon doesn't start if the state
  directory is writable by other users.
- **A token for every boot.** The daemon writes a random token to
  `<state dir>/foreman.sock.token` (0600) when it starts. The client and
  the daemon each prove they know it (an HMAC challenge), and the token
  itself never crosses the socket. The client checks the daemon's proof
  before it sends anything, so a stale or foreign socket gets neither a
  hook payload nor an agent token. A client that can't prove the token is
  refused.
- **The client checks before it trusts.** A socket or token file that
  isn't owned by you, is open to other users, or is a symlink is ignored,
  and the client decides in its own process.
- **The token doesn't say which agent you are.** It only proves "a
  Foreman client of this user". An agent still proves its id with its own
  [identity token](./agent-lifecycle.md#agent-identity-tokens): its
  `foreman mcp-stdio` passes `FOREMAN_AGENT_TOKEN` and `--source` to the
  daemon, which checks them exactly as the agent's own process would and
  re-checks them before every message. An agent without a valid token is
  `untrusted:<id>` there too, and gets no hub servers.
- **Fail closed.** Once a call has been handed to the daemon, a daemon
  that stops or crashes never lets it through. The hook exits 2 (Claude
  Code blocks the tool), and an MCP call gets an error. The call is not
  sent again; the agent's `foreman mcp-stdio` serves later calls in its
  own process. The daemon cancels (denies) a pending approval when the
  hook or agent waiting for it goes away. Whether to use the daemon at all
  is only decided before a call starts.
- **New session, fresh checks.** When an agent connects, the daemon
  re-reads the tool pins and checks each server's live tool definitions
  against them before the next call, as a freshly started
  `foreman mcp-stdio` would. `foreman mcp trust` is picked up the same
  way.

Differences to know about:

- Stdio servers started by the daemon get the proxy and CA variables
  (`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, …) from the environment
  `foreman start` runs in, not from the agent's.
- A broken `mcp.yaml` is reported in the Foreman inbox rather than on the
  agent's stderr.
- **Windows:** the daemon needs Unix-socket permissions, so native Windows
  keeps the in-process path. Under WSL2 the daemon works as on Linux.

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

| Command                                                               |                                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `foreman mcp catalog [--category c] [--json]`                         | Curated servers                                                                       |
| `foreman mcp add <id> [args…]`                                        | Add from the catalog, or `--command` / `--url` for your own (`--oauth` for MCP OAuth) |
| `foreman mcp list`                                                    | Configured servers, missing secrets, OAuth status                                     |
| `foreman mcp login <name> [--scope s] [--no-browser] [--timeout sec]` | Sign in to an `auth: oauth` server                                                    |
| `foreman mcp logout <name>`                                           | Delete a server's stored OAuth tokens (revoked at the provider when possible)         |
| `foreman mcp tools [name] [--refresh]`                                | Connect, list tools, scan findings, token cost                                        |
| `foreman mcp trust <name> [--include-flagged]`                        | Accept current definitions (after an update)                                          |
| `foreman mcp enable / disable / remove <name>`                        |                                                                                       |
| `foreman mcp mode auto\|eager\|lazy`                                  | Discovery mode                                                                        |

## Limits and roadmap

- OAuth servers must support dynamic client registration. Servers that
  only accept pre-registered clients aren't supported yet.
- Without the daemon (no `foreman start` or `foreman daemon` running),
  each agent's `foreman mcp-stdio` runs its own copy of stdio servers
  (started lazily, reusing the pinned listing).
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
