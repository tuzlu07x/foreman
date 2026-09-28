# Policy reference (`policy.yaml`)

`policy.yaml` is where you tell Foreman which tool calls, and which hand-offs from one agent to another, to allow, to ask you about and to refuse. This page covers where the file lives, every field it accepts, how Foreman picks between rules that disagree, the rules Foreman adds for you, and how edits take effect.

Foreman's risk engine runs next to the policy: it scores each call and can ask you even when a rule allows it. See [`detection.md`](detection.md) for the scoring.

## Where the file is

`policy.yaml` is in Foreman's config directory:

| Platform | Path |
| --- | --- |
| Linux, WSL2 | `~/.config/foreman/policy.yaml` (`$XDG_CONFIG_HOME/foreman/` if set) |
| macOS | `~/Library/Application Support/foreman/policy.yaml` |
| `FOREMAN_HOME` set | `$FOREMAN_HOME/policy.yaml` |

`foreman init` (and the first `foreman start`) writes the default template. `foreman doctor` prints the directory on its `foreman_home` line.

```bash
foreman policy show            # the rules Foreman loaded, numbered
foreman policy show --json     # the same with every condition, plus bucket overrides
foreman policy edit            # open it in $EDITOR, then load it and report the rule count
foreman policy reset           # overwrite it with the default template (asks first)
foreman policy remembered list # the rules your "always" answers and block buttons made
foreman policy remembered remove <id>
```

`policy show`, `policy edit` and `foreman doctor` validate the file. A mistake is reported with the field that's wrong and, where Foreman can tell, the line, for example:

```
error: ~/.config/foreman/policy.yaml failed to parse (line 63): rules.4.effect: Invalid enum value. Expected 'allow' | 'deny' | 'ask', received 'maybe'
```

## How a call is decided

For every tool call an agent makes, and every hand-off from one agent to another (see [Hand-offs](#hand-offs-between-agents)), Foreman goes through these steps in order and stops at the first one that decides:

1. **Blocked or disabled agent**: denied (`agent:blocked`, `agent:disabled`). See [`agent-lifecycle.md`](agent-lifecycle.md).
2. **Rate limits** (`agents.<id>.rate_limits`): denied when the agent is over its calls per minute or tokens per hour.
3. **Policy rules**: the matching rules pick `allow`, `ask` or `deny` (see [Which rule wins](#which-rule-wins)). `deny` refuses the call here (`policy:<rule id>`).
4. **Risk engine**: scores the call and puts it in a bucket: low (0–29), medium (30–59), high (60–84) or critical (85–100). By default low is allowed and the rest ask; [`buckets:`](#risk-buckets-buckets) can change that. A bucket set to `deny` refuses the call (`risk:<bucket>`), even when a rule allows it.
5. **Your approval**: if the policy said `ask` *or* the risk engine did, the call waits for you (`user:tui`, `user:telegram`, …, or `approval-timeout` when nobody answered). See [How approvals work](tui.md#how-approvals-work).
6. Otherwise the call is allowed. The label names the rule that allowed it (`policy:<rule id>`), or the fallback when no rule matched (`policy:hook:risk-based`, `policy:mcp.yaml:<server>`, `policy:org.yaml` for a hand-off).

So:

- `deny` always refuses. Nothing later can lift it.
- `ask` always asks, whatever the risk score (unless a bucket set to `deny` refuses the call first).
- `allow` only means the policy won't ask. The risk engine still asks about a risky call (a `curl … | sh`, a secret-looking path, a call you denied before).

These labels (`policy:12`, `risk:critical`, `approval-timeout`, …) are what `foreman log tail` and the TUI's activity feed show after `allowed` or `denied`.

## Rules (`rules:`)

```yaml
rules:
  - source: "*"                 # which agent: an agent id, or "*" for any
    target: "tool:read_file"    # which call
    effect: ask                 # allow | ask | deny
    conditions:                 # optional: narrow the rule to some calls
      pathMatch:
        - "(^|/)\\.env(\\..*)?$"
```

| Field | Required | Meaning |
| --- | --- | --- |
| `source` | yes | The agent id the rule applies to (as in `foreman agent list`), or `"*"` for every agent. |
| `target` | yes | The call, matched exactly (no wildcards, but see [Tool-name aliases](#tool-name-aliases)): `tool:<name>` for a tool call, `secret:<name>` for the MCP `secrets/get` tool, or `<agent>:write` for handing work to another agent (see [Hand-offs](#hand-offs-between-agents)). |
| `effect` | yes | `allow`, `ask` or `deny`. |
| `conditions` | no | Narrows the rule; see below. Without conditions the rule applies to every call of that target. |

There is no priority field, and the order of rules in the file doesn't change any decision.

### Tool names

Rules use Foreman's name for a tool, which depends on how the agent reaches Foreman:

| Where the call comes from | `target` |
| --- | --- |
| An MCP agent through `foreman mcp-stdio` | `tool:<the tool name the agent called>`, e.g. `tool:read_file`, `tool:shell_exec` |
| An MCP hub server (`foreman mcp add …`) | `tool:<server>__<tool>`, e.g. `tool:github__create_issue` |
| Claude Code's PreToolUse hook | `Bash` → `tool:shell_exec`; `Read` → `tool:read_file`; `Write`, `Edit`, `MultiEdit`, `NotebookEdit` → `tool:file_write`; `Grep`, `Glob` → `tool:search_files`; `WebFetch`, `WebSearch` → `tool:network_fetch`; `mcp__*` → `tool:mcp_call`; anything else lower-cased |
| Codex | `tool:shell_exec` (commands), `tool:file_write` (file changes), `tool:permission_overlay` (permission requests) |
| Hermes, OpenClaw, ZeroClaw (ACP) | `tool:shell_exec` (execute), `tool:file_write` (edit, delete, move), `tool:network_fetch` (fetch), `tool:read` (read); other kinds as they come (`search`, `think`, `other`) |

`foreman log tail` shows the name each call arrived with.

### Tool-name aliases

Transports use different names for the same kind of call, so Foreman treats these names as one group each:

| Kind | Names |
| --- | --- |
| read a file | `read_file`, `read`, `read_text_file`, `read_multiple_files`, `read_media_file` |
| write a file | `file_write`, `write_file`, `edit_file`, `write`, `edit`, `create_file`, `move_file` |
| run a command | `shell_exec`, `execute`, `execute_code`, `run_command`, `run_shell`, `bash`, `sh`, `zsh`, `exec` |
| fetch a URL | `network_fetch`, `fetch`, `fetch_url`, `web_fetch` |

A `deny` or `ask` rule written for one name also applies to the others in its group: the default `.env` guard on `tool:read_file` also covers Hermes' `tool:read` and the MCP filesystem server's `read_text_file`. An `allow` rule covers only the name it was written for, so an alias never widens a permission.

### Conditions

| Condition | Type | The rule applies when… |
| --- | --- | --- |
| `pathMatch` | list of regexes | a path argument matches one of them |
| `pathNotMatch` | one regex | the path arguments are *not* all excluded by it (see below) |
| `commandMatch` | list of substrings | a command argument contains one of them |
| `toolPattern` | regex | the tool name matches it (case-sensitive) |
| `argContains` | string | any string argument contains it (case-insensitive) |

Every condition in a rule must hold. Details:

- **Path arguments** are `path`, `file_path`, `filePath`, `filename`, `file`, `notebook_path`, `target_path`, `source`, `destination` and `paths` (a list). Each is also checked in a normalised form (backslashes turned into `/`, `a/../b` collapsed), so `x/../.env` can't slip past a `.env` pattern. Path regexes are **case-insensitive**. A call with no path argument never matches `pathMatch`.
- **Command arguments** are `cmd`, `script` and `command` (with `args` appended when present). Matching is a plain, case-sensitive substring test after collapsing runs of whitespace. `commandMatch: ["npm test"]` also matches `npm test && curl … | sh`.
- **Regexes** are JavaScript regular expressions, written as YAML strings, so a backslash is doubled inside double quotes (`"\\.env$"`). A glob like `*.env` is not a valid regex.

Conditions are applied so that a mistake fails safe:

| | `deny` / `ask` rule | `allow` rule |
| --- | --- | --- |
| Several paths or commands in one call | applies if **any** of them matches | applies only if **every** one matches |
| `pathNotMatch` | skipped only when **every** path is excluded | skipped when **any** path is excluded |
| A regex that doesn't compile | the rule still applies | the rule never applies |

### Which rule wins

When several rules match a call:

1. A `deny` rule whose `source` is this agent's id always wins.
2. Otherwise a rule **overrides** another when it is at least as specific on both counts, and more specific on one. The two counts: an exact `source` is more specific than `"*"`, and a rule with conditions is more specific than one without.
3. Among the rules nothing overrides, the strictest wins: `deny`, then `ask`, then `allow`.
4. If no rule matches, the call is asked about. Three exceptions: for Claude Code's hook the risk engine decides alone (it allows unless the score asks); for MCP hub tools the server's `tools:` lists in `mcp.yaml` decide, with unlisted tools asking (see [`mcp-hub.md`](mcp-hub.md#mcpyaml)); and a hand-off follows the org chart ([`org.md`](org.md)).

With the default policy:

| Call | Matching rules | Result |
| --- | --- | --- |
| any agent reads `README.md` | `* read_file allow` | allowed (unless the risk engine asks) |
| any agent reads `.env` | `* read_file allow`, `* read_file ask` + `pathMatch` | ask: the conditional rule overrides the blanket one |
| `hermes`, with your own rule `source: hermes, target: tool:read_file, effect: allow`, reads `.env` | `hermes read_file allow`, `* read_file ask` + `pathMatch` | ask: neither overrides the other (one has the exact source, the other the conditions), so the stricter one wins |
| `hermes` reads `README.md` | `hermes read_file allow`, `* read_file allow` | allowed |
| Hermes (ACP) reads `.env` as `tool:read` | `* read_file ask` + `pathMatch` (alias) | ask |
| an agent calls a tool no rule mentions | none | ask |

## Per-agent settings (`agents:`)

```yaml
agents:
  hermes:
    can_access_secrets: [github-pat]
    cannot_access_secrets: [stripe-key]
    rate_limits:
      messages_per_minute: 30
      tokens_per_hour: 100000
    can_call:
      claude-code: [write]
    cannot_call:
      codex: [write]
```

| Field | Meaning |
| --- | --- |
| `can_access_secrets` | Secrets the agent may fetch with the MCP `secrets/get` tool. Secret access is **deny by default**: only an explicit allow grants it. Becomes a `secret:<name>` allow rule. |
| `cannot_access_secrets` | Secrets it may never fetch, even through a `"*"` allow. |
| `rate_limits.messages_per_minute` | Once the agent has made this many calls in the last 60 seconds, further calls are denied (`policy:<rule id>`). It shows in `policy show` as `<agent> → * +cond ASK`. |
| `rate_limits.tokens_per_hour` | Once the tokens the agent used in the last hour reach this, further calls are denied the same way. Usage comes from Foreman's spend ledger (agent telemetry, task output, Foreman's own calls), so an agent that reports no usage isn't limited by it. |
| `can_call` / `cannot_call` | What this agent may hand to another agent; see [Hand-offs](#hand-offs-between-agents). |

To restrict an agent's **own** tool calls, use `rules:` with its id as `source` and `target: "tool:<name>"`.

An unverified connection claiming the agent's id is counted against its rate limits too.

Reserved secrets (agent identity tokens, MCP OAuth sessions) can't be fetched through `secrets/get` whatever the policy says.

### Hand-offs between agents

When an agent hands work to another agent (`/foreman write <agent> …`, `assign`, or `foreman write` from a shell Foreman spawned for it), Foreman decides the hand-off like a call: source the handing agent, target `<other agent>:write`, the task as its argument. It is checked before the task is queued, and shows in `foreman log tail` as `hermes → codex write(task="…")`.

- `cannot_call: {codex: [write]}` becomes a `codex:write` deny rule: hermes can't hand codex work (`policy:<rule id>`).
- `can_call: {claude-code: [write]}` becomes a `claude-code:write` allow rule, and makes the list for that agent exhaustive: once you list what hermes may do on claude-code, anything else on claude-code is denied (`policy:can_call`). Calls to agents you didn't list aren't affected.
- You can write the same as `rules:` (`source: hermes`, `target: "codex:write"`), with any effect, including `ask`.
- With no rule, the org chart decides (`policy:org.yaml`, see [`org.md`](org.md)), and the risk engine can still ask you.
- An allow rule doesn't lift a block from the org chart: a hand-off `org.yaml` refuses stays refused. `foreman org check <from> <to>` shows both.

These rules bind agents only. You at the terminal, in the TUI console or in your own chat aren't an agent, so they don't apply to what you hand out.

## Unverified connections (`identity:`)

An MCP connection that doesn't prove its agent id with the agent's identity token runs as `untrusted:<claimed id>` (see [Agent identity tokens](agent-lifecycle.md#agent-identity-tokens)). `identity.untrusted` decides what it may do:

```yaml
identity:
  untrusted: ask
```

| Value | Effect |
| --- | --- |
| `ask` (default) | Nothing is auto-allowed: every call that isn't denied comes to you. |
| `deny` | Every call is refused (`policy:identity:untrusted`). |
| `allow_wildcards` | `source: "*"` allow rules apply to it, as to any agent; it can also read secrets through a `"*"` secret rule. |

In every mode it gets none of the claimed agent's own allow rules, while the claimed agent's `deny` and `ask` rules, its block or pause, and its rate limits still bind it. All unverified connections together get at most 30 calls a minute and 3 approvals waiting at once. "Always allow" isn't remembered for them.

## Risk buckets (`buckets:`)

Overrides what the risk engine recommends for a bucket:

```yaml
buckets:
  critical: deny   # refuse anything scoring 85+ without asking
  medium: ask      # the default, spelled out
```

Keys: `low`, `medium`, `high`, `critical`. Values: `allow`, `ask`, `deny`. A bucket set to `allow` still asks when a policy rule says `ask`. `foreman policy show` lists active overrides under `bucket overrides:`. See [`detection.md`](detection.md#8-per-bucket-overrides-in-policyyaml).

## `responsibility_policies`

Checks calls against each agent's responsibility note (set in the wizard, on the TUI's Agents page with `N`, or with `foreman agent responsibility <id> "<note>"`). A policy applies to agents whose note equals `responsibility`, ignoring case. These add risk points; they never deny on their own.

```yaml
responsibility_policies:
  - responsibility: "code writing"
    cannot_access:                      # regexes; a matching path adds 60 points
      - "/\\.ssh/"
    can_call_agents_with_responsibility: ["code review", "testing"]   # another known role adds 40
    cannot_call_agents_with_responsibility: ["payment processing"]   # adds 50
    can_use_services: [github]          # other known services add 40
```

`cannot_call_agents_with_responsibility` is checked on [hand-offs](#hand-offs-between-agents), against the receiving agent's note. `can_call_agents_with_responsibility` is the allowlist form: a hand-off to an agent whose note is known and isn't on the list adds 40 (an agent without a note adds nothing). `can_use_services` only applies when the target is a service id (`telegram`, `github`, …), which no current call has.

## Session limits (`session_limits:`)

For sessions Foreman manages itself:

```yaml
session_limits:
  token_limit: 100000             # halt the session past this many tokens (default 100000)
  token_budget_warning_pct: 80    # warn in the risk score from this share of the limit (default 80)
```

## Rules Foreman adds for you

### "Always allow" and "Always deny" (`A` / `D`)

In the TUI's approval view, `A` allows the call and remembers the decision, and `D` denies it and remembers. Before you press either, the approval shows what it would remember (`remembers: hermes → read_file, only for "/p/.env"`); `D` then asks `y` to confirm, and so does `A` on a high- or critical-risk call. The remembered rule:

- covers the call you answered: the same agent, the same tool and, when the call names a file or a command, that exact file (a `pathMatch` on it) or that command (a `commandMatch`). Only a call with neither covers the whole tool, and the approval then says "every `<tool>` call from `<agent>`".
- is stored in Foreman's database, not in `policy.yaml`, and kept when the file changes. `foreman policy show` lists it as `(remember-action)`.
- ranks as an exact-source rule with conditions, so it overrides a `"*"` rule for that file or command. The risk engine can still ask about the call.

"Always allow" isn't remembered for an unverified (`untrusted:`) connection; "always deny" is.

List and remove them from the CLI:

```bash
foreman policy remembered list          # newest first; --json for scripts
# #13  generic-mcp → tool:read_file  DENY  only when path matches ^/p/\.env$  2026-09-28T12:17:37.646Z
foreman policy remembered remove 13     # asks first; --yes to skip
```

Rules from `policy.yaml` can't be removed this way; edit the file. You can also turn a remembered rule off on the TUI's Policy page (`d`).

### Block buttons in Telegram

Some approval messages in Telegram carry a **block** button for the pattern that raised the risk (for example, this agent reading `.env` files). Tapping it denies the call and adds a `deny` rule with that condition to `rules:` in `policy.yaml`, under a `# === Foreman approval-injected rule ===` comment; the rest of the file keeps its comments and layout. The file is the rule's only copy (if `policy.yaml` is missing or doesn't parse, it is kept in the database instead), so deleting the entry from the file removes the rule. `foreman policy remembered list` shows block rules too, and `remove <id>` takes the entry out of the file.

## The TUI Policy page

`p` on the Home page lists every loaded rule with its conditions. `↑` `↓` select, `Enter` shows its details, `d` turns it on or off, and `e` opens `policy.yaml` in `$EDITOR`. A rule from `policy.yaml` that you turn off stays off while the rule is unchanged in the file; to drop it for good, delete it from the file.

## How edits apply

Save `policy.yaml` and the change applies from the next call, no restart: `foreman start`, every running `foreman mcp-stdio`, `foreman wrap` and the Claude Code hook check the file (at most every 250 ms) before each decision. Check an edit with `foreman policy show`, which prints the loaded rules or the first error.

- **An edit that doesn't parse** isn't applied: processes already running keep the last policy that loaded, and report the error once (on stderr, or in the inbox for `foreman start`).
- **A file that doesn't parse at startup** stops the process, with the file, line and reason: `foreman start`, a new `foreman mcp-stdio` connection and `foreman wrap` exit 1, and the Claude Code hook blocks the call. Nothing runs on a policy the file doesn't say.
- **Rule ids are stable.** A rule you didn't change keeps its number, so `policy:12` in the audit log keeps pointing at the rule that decided. Only an edited rule gets a new one.

## Examples

Never let `hermes` read private keys, whatever else allows it:

```yaml
rules:
  - source: hermes
    target: "tool:read_file"
    effect: deny
    conditions:
      pathMatch: ["\\.pem$", "(^|/)id_(rsa|ed25519)$"]
```

Let `codex` run the test suite without asking. Keep in mind that `commandMatch` is a substring test, so the risk engine is what catches `npm test && curl … | sh`:

```yaml
rules:
  - source: codex
    target: "tool:shell_exec"
    effect: allow
    conditions:
      commandMatch: ["npm test"]
```

Always ask before any agent merges a pull request through the GitHub hub server:

```yaml
rules:
  - source: "*"
    target: "tool:github__merge_pull_request"
    effect: ask
```

Ask before any call that mentions a paste site:

```yaml
rules:
  - source: "*"
    target: "tool:network_fetch"
    effect: ask
    conditions:
      argContains: "pastebin.com"
```

Give one agent one secret, and slow it down:

```yaml
agents:
  my-bot:
    can_access_secrets: [github-pat]
    rate_limits:
      messages_per_minute: 20
      tokens_per_hour: 200000
```

Let `hermes` hand work to `claude-code` but never to `codex`, and ask you before `openclaw` hands anything to `codex`:

```yaml
agents:
  hermes:
    can_call:
      claude-code: [write]
    cannot_call:
      codex: [write]
rules:
  - source: openclaw
    target: "codex:write"
    effect: ask
```

Refuse critical-risk calls outright, and quarantine agents that don't prove their identity:

```yaml
buckets:
  critical: deny
identity:
  untrusted: deny
```

More complete files: [`examples/hermes-integration/example-policy.yaml`](../examples/hermes-integration/example-policy.yaml) and [`examples/openclaw-integration/example-policy.yaml`](../examples/openclaw-integration/example-policy.yaml).
