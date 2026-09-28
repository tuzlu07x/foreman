# Policy reference (`policy.yaml`)

`policy.yaml` is where you tell Foreman which tool calls to allow, which to ask you about and which to refuse. This page covers where the file lives, every field it accepts, how Foreman picks between rules that disagree, the rules Foreman adds for you, and how edits take effect.

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
```

`policy show` and `policy edit` validate the file. A mistake is reported with the field that's wrong, for example:

```
error: ~/.config/foreman/policy.yaml failed to parse: rules.0.effect: Required
```

## How a call is decided

For every tool call an agent makes, Foreman goes through these steps in order and stops at the first one that decides:

1. **Blocked or disabled agent**: denied (`agent:blocked`, `agent:disabled`). See [`agent-lifecycle.md`](agent-lifecycle.md).
2. **Rate limit** (`agents.<id>.rate_limits`): denied when the agent is over its limit.
3. **Policy rules**: the matching rules pick `allow`, `ask` or `deny` (see [Which rule wins](#which-rule-wins)). `deny` refuses the call here (`policy:<rule id>`).
4. **Risk engine**: scores the call and puts it in a bucket: low (0–29), medium (30–59), high (60–84) or critical (85–100). By default low is allowed and the rest ask; [`buckets:`](#risk-buckets-buckets) can change that. A bucket set to `deny` refuses the call (`risk:<bucket>`), even when a rule allows it.
5. **Your approval**: if the policy said `ask` *or* the risk engine did, the call waits for you (`user:tui`, `user:telegram`, …, or `approval-timeout` when nobody answered). See [How approvals work](tui.md#how-approvals-work).
6. Otherwise the call is allowed. The label names the rule that allowed it (`policy:<rule id>`), or the fallback when no rule matched (`policy:hook:risk-based`, `policy:mcp.yaml:<server>`).

So:

- `deny` always refuses. Nothing later can lift it.
- `ask` always asks, whatever the risk score (unless a bucket set to `deny` refuses the call first).
- `allow` only means the policy won't ask. The risk engine still asks about a risky call (a `curl … | sh`, a secret-looking path, a call that was denied before).

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
| `target` | yes | The call, matched exactly (no wildcards): `tool:<name>` for a tool call, `secret:<name>` for the MCP `secrets/get` tool, or `<agent>:<tool>` for a call from one agent to another (see [`agents:`](#per-agent-settings-agents)). |
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

That's why the default policy guards both `tool:write_file` and `tool:file_write`. `foreman log tail` shows the name each call arrived with.

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
4. If no rule matches, the call is asked about. Two exceptions: for Claude Code's hook the risk engine decides alone (it allows unless the score asks), and for MCP hub tools the server's `tools:` lists in `mcp.yaml` decide, with unlisted tools asking (see [`mcp-hub.md`](mcp-hub.md#mcpyaml)).

With the default policy:

| Call | Matching rules | Result |
| --- | --- | --- |
| any agent reads `README.md` | `* read_file allow` | allowed (unless the risk engine asks) |
| any agent reads `.env` | `* read_file allow`, `* read_file ask` + `pathMatch` | ask: the conditional rule overrides the blanket one |
| `hermes`, which you allowed "always" for `read_file`, reads `.env` | `hermes read_file allow`, `* read_file ask` + `pathMatch` | ask: neither overrides the other (one has the exact source, the other the conditions), so the stricter one wins |
| `hermes` reads `README.md` | `hermes read_file allow`, `* read_file allow` | allowed |
| an agent calls a tool no rule mentions | none | ask |

## Per-agent settings (`agents:`)

```yaml
agents:
  hermes:
    can_access_secrets: [github-pat]
    cannot_access_secrets: [stripe-key]
    rate_limits:
      messages_per_minute: 30
    can_call:
      claude-code: [read_file, list_files]
    cannot_call:
      claude-code: [write_file, shell_exec]
```

| Field | Meaning |
| --- | --- |
| `can_access_secrets` | Secrets the agent may fetch with the MCP `secrets/get` tool. Secret access is **deny by default**: only an explicit allow grants it. Becomes a `secret:<name>` allow rule. |
| `cannot_access_secrets` | Secrets it may never fetch, even through a `"*"` allow. |
| `rate_limits.messages_per_minute` | Once the agent has made this many calls in the last 60 seconds, further calls are denied (`policy:<rule id>`). It shows in `policy show` as `<agent> → * +cond ASK`. |
| `rate_limits.tokens_per_hour` | Accepted and shown on the TUI's Policy page, but not enforced yet. |
| `can_call` / `cannot_call` | `<agent>: [tools]` becomes `<agent>:<tool>` allow / deny rules for calls one agent makes to another through Foreman's mediator. None of the current transports (MCP, hook, wrap, ACP, Codex) sends such calls, so these rules don't affect any call today. Delegation between agents (`foreman write`, `assign`) is governed by [`org.yaml`](org.md) instead. |

To restrict an agent's **own** tool calls, use `rules:` with its id as `source` and `target: "tool:<name>"`.

Reserved secrets (agent identity tokens, MCP OAuth sessions) can't be fetched through `secrets/get` whatever the policy says.

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
    can_call_agents_with_responsibility: ["code review", "testing"]
    cannot_call_agents_with_responsibility: ["payment processing"]   # adds 50
    can_use_services: [github]          # other known services add 40
```

The agent-to-agent and service fields apply to calls from one agent to another, so like `can_call` they don't affect today's calls.

## Session limits (`session_limits:`)

For sessions Foreman manages itself:

```yaml
session_limits:
  token_limit: 100000             # halt the session past this many tokens (default 100000)
  token_budget_warning_pct: 80    # warn in the risk score from this share of the limit (default 80)
```

## Rules Foreman adds for you

### "Always allow" and "Always deny" (`A` / `D`)

In the TUI's approval view, `A` allows the call and remembers the decision, and `D` denies it and remembers. The remembered rule is:

- `source`: the agent's id; `target`: `tool:<name>`; `effect`: `allow` or `deny`; **no conditions**. `D` on a `read_file` of `~/.ssh/id_rsa` therefore denies every `read_file` from that agent, not just that path.
- stored in Foreman's database, not in `policy.yaml`, and kept when the file is loaded again. `foreman policy show` lists it as `(remember-action)`.
- ranked like any exact-source rule without conditions: an "always allow" beats a blanket `"*"` ask but not a targeted one (`.env` reads still ask), and the risk engine can still ask. An "always deny" wins over everything for that agent and tool.

"Always allow" isn't remembered for an unverified (`untrusted:`) connection; "always deny" is.

To undo one, open the Policy page (`p` on the TUI's Home page), select the rule and press `d` to turn it off. There's no CLI command for it yet.

### Block buttons in Telegram

Some approval messages in Telegram carry a **block** button for the pattern that raised the risk (for example, this agent reading `.env` files). Tapping it denies the call and adds a `deny` rule with that condition. The rule is stored in the database and also appended to `policy.yaml` under a `# === Foreman approval-injected rule ===` comment. To remove it, delete that block from the file and turn off the matching `(remember-action)` rule on the Policy page.

## The TUI Policy page

`p` on the Home page lists every loaded rule. `↑` `↓` select, `Enter` shows its details, `d` turns it on or off, and `e` opens `policy.yaml` in `$EDITOR` and loads it when you close the editor. Turning off a rule that comes from `policy.yaml` lasts until the file is loaded again; to drop it for good, edit the file.

## How edits apply

<!-- pending: #656/#657 -->
Save `policy.yaml` and the change applies from the next call: a running `foreman start` and your agents' `foreman mcp-stdio` connections pick it up without a restart. Check an edit with `foreman policy show`, which prints the loaded rules or the first error.

Rule numbers (`#12`, `policy:12`) are assigned when the file is loaded, so look them up with `foreman policy show` rather than keeping them.

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
```

Refuse critical-risk calls outright, and quarantine agents that don't prove their identity:

```yaml
buckets:
  critical: deny
identity:
  untrusted: deny
```

More complete files: [`examples/hermes-integration/example-policy.yaml`](../examples/hermes-integration/example-policy.yaml) and [`examples/openclaw-integration/example-policy.yaml`](../examples/openclaw-integration/example-policy.yaml).
