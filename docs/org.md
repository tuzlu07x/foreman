# Foreman Org — run your company as a crew of agents

Real companies scale through structure: a CEO sets direction, department
heads own their areas, teams execute, and work moves along reporting lines.
Foreman Org gives your agents the same shape — and enforces it.

```
Acme Inc.
you (Founder)
└─ ceo · Chief Executive (agent) · ● hermes
   ├─ cto · CTO · ● claude-code [Engineering] mcp: github, filesystem, playwright, sentry
   │  └─ engineer · Software Engineer · ● codex [Engineering]
   ├─ cmo · CMO · ● openclaw [Marketing] mcp: notion, brave-search, youtube
   ├─ cfo · CFO · ● zeroclaw [Finance] mcp: stripe
   └─ support-lead · Support Lead · ○ generic-mcp [Customer Support] mcp: notion
```

## Quick start

```bash
foreman org templates                                  # startup · software-team · solo
foreman org init --template startup --company "Acme"   # writes org.yaml
foreman org show                                       # the chart above
foreman org sync                                       # push roles to registered agents
foreman org assign marketing "draft the launch post"   # department → its head
```

Any registered runtime can fill a role — Claude Code, Codex, Hermes,
OpenClaw, ZeroClaw or your own MCP agent (`foreman agent add <id>`).

## What the chart enforces

**Delegation follows reporting lines.** When an agent hands work to another
(`/foreman write <agent> …` from chat, or `foreman write` from a shell
Foreman spawned for it), Foreman checks the chart:

| From → To | Default |
| --- | --- |
| manager → direct report | ✅ |
| manager → anyone below (`skip_levels: true`) | ✅ |
| report → own manager | ✅ |
| colleagues in the same department | ✅ |
| department head ↔ department head | ✅ (`cross_department: via_heads`) |
| anyone else across departments | ❌ "hand it to your manager" |
| you (terminal / owner) → anyone | ✅ always |

`cross_department` can also be `allow` or `deny` (isolated departments).
`foreman org check <from> <to>` explains any decision.

**Least-privilege tools.** Each department (or a single role) lists the
[MCP hub](./mcp-hub.md) servers it may use. Finance sees Stripe, not GitHub;
engineers see GitHub, not Stripe. Fewer tools per agent also means fewer
tokens per turn.

**You stay on top.** Approvals for risky calls always come to you (TUI,
Telegram), whatever the chart says.

## `org.yaml`

```yaml
version: 1
company: "Acme Inc."
mission: "Ship a great product with a small team."
human: { title: Founder }
delegation:
  cross_department: via_heads   # via_heads | allow | deny
  skip_levels: true
departments:
  engineering:
    name: Engineering
    head: cto
    mcp_servers: [github, filesystem, playwright, sentry]
roles:
  ceo:
    title: Chief Executive (agent)
    agent: hermes
    reports_to: human
    responsibility: "strategy, planning, delegation"
  cto:
    title: CTO
    agent: claude-code
    department: engineering
    reports_to: ceo
  engineer:
    title: Software Engineer
    agent: codex
    department: engineering
    reports_to: cto
    model: <cheaper-model-id>    # optional: a cheaper model for routine work
```

Validation (`foreman org validate`) rejects reporting cycles, unknown
managers or departments, and heads outside their own department, and warns
about roles filled by agents you haven't registered yet.

## Commands

| Command | |
| --- | --- |
| `foreman org templates` | Starter charts |
| `foreman org init [--template t] [--company n] [--force]` | Create org.yaml |
| `foreman org show [--json]` | The chart, with registration status and tool access |
| `foreman org validate` | Structure + warnings |
| `foreman org check <from> <to>` | Explain a delegation decision |
| `foreman org assign <role\|department\|agent> <task…>` | Queue a task (needs `foreman start` running) |
| `foreman org sync` | Push titles / responsibilities / model overrides into the agent registry |
| `foreman org upgrade` | Upgrade every agent runtime the org uses |
| `foreman org add-department <id> --head <role> [--agent a] [--name n]` | Add a department and its head |
| `foreman org add-role <id> --agent a [--department d] [--reports-to r]` | Add a role (defaults to reporting to the department head) |
| `foreman org report [target] [period]` | What a department, role or agent did, and what it cost |
| `foreman org budget <department> [usd\|off] [--daily] [--pause]` | Set or remove a spend limit |
| `foreman usage [period] [--by department\|agent\|model]` | Spend at a glance |
| `foreman usage env <agent>` | Turn on spend tracking for an agent you start yourself |

## Grow the company

Any number of departments, any names. Each one is a line:

```bash
foreman org add-department sales --head cso --agent codex --name Sales
foreman org add-role sdr --agent hermes --department sales --title "Sales rep"
foreman org add-role analyst --agent claude-code --department sales --model claude-haiku-4-5
foreman org show
```

A new role reports to its department head unless you say otherwise
(`--reports-to`). Both commands check the whole chart before saving, and
they keep the comments in `org.yaml`. You can still edit the file by hand;
it's read again on every delegation, so no restart is needed.

## Spend and reports

Ask what a department did and what it cost, from any surface:

```bash
foreman org report marketing today        # or week, month, 7d, 24h
foreman org report                        # the whole company, by department
foreman usage month --by agent
```

In the TUI console, Telegram, Slack or Discord:

```
/foreman report marketing month
/foreman spend                  # today, by department
```

A report shows:
- spend, and tokens (input, output, cache);
- finished and failed tasks, and cost per finished task;
- tool calls allowed and blocked;
- the latest task results;
- budget use.

It needs no LLM. `report me` still asks Foreman's own LLM for a narrated
summary.

### Where the numbers come from

| Source | How | Precision |
| --- | --- | --- |
| **Agent telemetry** | Claude Code (and Codex) export OpenTelemetry. `foreman start` listens on `127.0.0.1:4319` and keeps only per-request token counts, model and cost; prompts never reach Foreman. | Exact, cost included |
| **Task output** | Usage an agent CLI prints when it finishes a task (`tokens used: N`, Claude JSON results), used only when that task sent no telemetry | Tokens exact; cost estimated (≈) from list prices |
| **Foreman itself** | Its own LLM calls (`llm_usage`) | Exact |

Tasks Foreman starts (`foreman write`, `assign`, delegation between
agents) report automatically: the agent gets the exporter settings and a
tag for the task. For agents **you** start, run this once:

```bash
foreman usage env claude-code   # prints the export lines for your shell profile
foreman usage env codex         # prints the [otel] block for ~/.codex/config.toml
```

Spend is attributed to the agent's role and department at the time it
happens. Moving an agent later doesn't rewrite history. If port 4319 is
taken, set `FOREMAN_OTLP_PORT`. The inbox tells you when that happens.

### Budgets

```bash
foreman org budget marketing 50            # $50 a month, alert at 80% and 100%
foreman org budget marketing 5 --daily     # and $5 a day
foreman org budget marketing 50 --pause    # when spent, agents can't hand it new work
foreman org budget marketing off
```

The budget lands in `org.yaml`:

```yaml
departments:
  marketing:
    name: Marketing
    head: cmo
    budget: { monthly_usd: 50, daily_usd: 5, on_exceed: pause }
```

Alerts go to the TUI inbox and to the channels on your `budget_alert` route.
With `pause`, agents can't delegate into the department until the period
resets. You can still assign work to it yourself.

## Scaling and upgrades

- Add a department or role by editing `org.yaml` — no restart needed; the
  chart is read on every delegation.
- `foreman org upgrade` updates all runtimes in one go (npm-installed agents
  are upgraded through npm; script-installed ones get the exact re-install
  command).
- `model:` per role lets routine roles run on a cheaper model — the single
  biggest lever on cost.

## Limits

- The chart organises work and limits blast radius; it is not an identity
  boundary. Agent ids are self-declared today (see [SECURITY.md](../SECURITY.md)).
- A broken `org.yaml` fails closed: agent-to-agent delegation is blocked and
  agents get no hub servers until `foreman org validate` passes.
- Approval escalation along the chart is on the roadmap.
- Spend covers what agents report: tasks Foreman starts, and agents you set
  up with `foreman usage env`. An agent that exports nothing and prints no
  usage shows tasks and tool calls, but no spend.
