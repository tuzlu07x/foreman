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
- Budgets per department and approval escalation along the chart are on the
  roadmap.
