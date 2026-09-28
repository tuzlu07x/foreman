# Integrations

Connect GitHub, GitLab, Jira and Confluence, Trello, Linear and Notion
once, and choose which of your agents may use each one. Every call an agent
makes still goes through Foreman: `policy.yaml`, risk scoring, your approval
when needed, and the audit log.

An integration is a managed [MCP hub](./mcp-hub.md) server: Foreman writes
its `mcp.yaml` block from a curated catalog, keeps the credential in the
encrypted secret store, and pins the server's tool definitions after you
review them.

## Quick start

```bash
foreman integrations catalog                     # what you can add
foreman integrations add github --agents claude-code,codex
foreman integrations list
```

`add` walks you through it:

1. **Credentials.** A token is read from a hidden prompt, never from the
   command line. A browser sign-in (OAuth) opens the provider's page.
2. **Saved disabled.** Nothing can call it yet.
3. **Review.** Foreman connects, scans the tool descriptions for poisoning,
   and pins them.
4. **Enabled.** Only now do the agents you chose see its tools. Agents that
   are already connected get them at once.

If a step fails, the integration stays disabled and Foreman tells you the
command that finishes it (`login`, `review`, `enable`).

The same flow is on the TUI's Integrations page (`i` in `foreman start`):
`n` adds, `space` enables or disables, `e` edits, `t` sets per-tool rules,
`r` reviews and `d` removes.

The setup wizard (`foreman setup`, or the wizard `foreman start` opens on a
fresh install) has an optional Integrations step after Services. It asks
for the access level and, for token integrations, the token; the agents you
picked in the wizard may use it. It saves each integration **disabled** and
never connects or opens a browser: finish it afterwards with
`foreman integrations review <name>` (token) or
`foreman integrations login <name>` (browser sign-in), then
`foreman integrations enable <name>`. The Done screen lists the commands.
Setups finished before this step existed are not sent back into the wizard.

In a script, give the audience and pipe the token:

```bash
printf '%s\n' "$GITHUB_TOKEN" | foreman integrations add github --token-stdin --agents codex
```

## What you can add

| Integration | Recommended | Other variants |
| --- | --- | --- |
| GitHub | hosted server, personal access token | local Docker (pinned image) |
| GitLab | GitLab's built-in server, browser sign-in (Premium / Ultimate) | community server with a token (any tier, self-managed) |
| Jira & Confluence | Atlassian Rovo server, browser sign-in | Rovo with an API token; community server for Server / Data Center |
| Trello | community server with an API key and token | Trello's official server (browser sign-in, not yet verified) |
| Linear | Linear's hosted server, browser sign-in | personal API key |
| Notion | Notion's hosted server, browser sign-in | integration token |

`foreman integrations catalog` shows the exact variants; pick one with
`--variant`. A self-managed GitLab needs its host:
`--param host=gitlab.example.com`.

## Read-only or read-write

New integrations are **read-only**: reads are allowed, and every write tool
is denied outright, not just asked about. `--read-write` (or `update
--read-write`) lets writes through to the usual approval. Some tools always
need a person, whatever the access level and whatever `policy.yaml` allows:
merging a pull request, pushing files. Deleting is denied by default.

Per-tool changes:

```bash
foreman integrations update github --tool create_issue=allow --tool get_me=deny
foreman integrations update github --tool create_issue=default   # back to the catalog's rule
```

A rule can only make a tool stricter than the catalog, never lift a deny or
a confirm; Foreman says so when yours has no effect. `policy.yaml` still wins
over all of it, and the risk engine still escalates risky calls.

## Who can use it

Every integration has an explicit audience:

| Flag | Who |
| --- | --- |
| `--agents claude-code,codex` | these agents |
| `--departments engineering` | every agent whose role in [`org.yaml`](./org.md) is in that department |
| `--all-agents` | every verified agent |

This narrows what `org.yaml` allows, never widens it: an agent needs both.
An agent connected without its [identity token](./agent-lifecycle.md#agent-identity-tokens)
sees no integration. `foreman integrations show <name>` lists each agent
with ✓ or ·.

```bash
foreman integrations update linear --departments product --agents hermes
```

## Everyday commands

| Command | |
| --- | --- |
| `foreman integrations list [--json]` | state (● enabled, ○ disabled, ⚠ needs attention), access level, tools, audience |
| `foreman integrations show <name> [--json]` | server, credentials, sign-in, access per agent, tool rules, problems |
| `foreman integrations enable / disable <name>` | disable takes effect for connected agents at once; enable is refused until it is ready |
| `foreman integrations update <name> …` | access level, audience, products, params, variant, per-tool rules; `--rotate <slot>` replaces a credential |
| `foreman integrations login / logout <name>` | browser sign-in for OAuth variants |
| `foreman integrations review <name>` | connect, scan and pin the tools (after an update, or when the server changed its tools) |
| `foreman integrations test <name>` | call the integration's health check (e.g. GitHub `get_me`) |
| `foreman integrations remove <name> [--keep-secrets] [--yes]` | remove it, its pins, its sign-in and the credentials nothing else uses; prints where to revoke access at the provider |
| `foreman integrations adopt <server> --id <integration> …` | manage a server you added with `foreman mcp add` as an integration |

`integration` works as an alias. Names resolve as the server name, then the
integration id, then an alias (`jira` → `atlassian`).

## From chat

From Slack, Discord or the Telegram approval bot you can list integrations
and enable, disable or remove them (removing asks for a one-time code);
see [notifications](notifications.md#integrations-from-chat). Adding one
and entering credentials happen only on the Foreman host.

## Two accounts

```bash
foreman integrations add github --name github-work --agents codex
```

The second account is its own server (`github-work__…` tools) with its own
secret (`github-pat-work`). With two GitHub servers, `gh` is ambiguous and
Foreman asks which one you mean.

## Security

- **Credentials stay with the hub.** Agents can't read an integration's
  token through `secrets/get`, whatever `policy.yaml` says, and it is never
  written into an agent's config files. Errors and the audit log carry
  secret names, never values.
- **Reviewed before use.** Tool definitions are pinned when you review
  them; a changed or new tool is withheld until you review again. Changing
  the variant or a parameter disables the integration until then.
- **Changes reach running agents.** Disabling an integration, or taking an
  agent off its list, applies to connected agents immediately, and a call
  that was waiting for your approval meanwhile is not sent.
- **Audited.** Every change is an `integration:*` event with who did it
  (`via: cli`); every call is an `mcp:call` with its decision.

## Limits

- GitHub's hosted server doesn't support OAuth client registration, so it
  takes a token.
- Browser sign-in needs dynamic client registration. Atlassian may need an
  organization admin to allow it; a self-managed GitLab can turn it off (use
  the community variant there).
- On a machine without a browser, forward the redirect port:
  `ssh -L <port>:127.0.0.1:<port> host`, using the port in the sign-in URL.
- Agents' own direct connections (a user-scope MCP server in their config,
  the `gh` CLI) bypass Foreman.
