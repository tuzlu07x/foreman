# Responsibility-Based Auto-Routing — Design Doc

**Status:** In progress (branch `feat/responsibility-routing`)
**Started:** 2026-05-25
**Driver:** User feedback — "aradaki insan faktorunu kaldiriyoruz komple"
**Issues:** to be filed alongside PR

## The problem we're solving

Today the user is in the loop between every agent step:

```
User → Hermes: "implement to-do-app, codex code, claude review"
Hermes → Foreman submit_command(write, codex)
Hermes → Foreman submit_command(write, claude-code)
Codex implements → output goes to USER via Telegram
Claude reviews → output goes to USER via Telegram   ← wrong: should go to codex
User reads Claude's review → copies feedback → tells Hermes to relay to codex   ← human in the loop
Codex applies → output goes to USER via Telegram
... loop ...
```

User wants:

```
User → Hermes: <goal>
Foreman orchestrates the loop autonomously based on each agent's
declared responsibility:
  codex implements → Foreman routes output to reviewer
  claude reviews → if changes_requested, Foreman routes back to codex;
                   if approved, Foreman routes to orchestrator
  hermes summarizes → final summary to user
User receives a single summary push at flow completion.
User can `foreman flow show <id>` to see the full step tree any time.
```

## Architecture

### 1. Agent role + responsibility model

Each registered agent gains three new fields:

| Field | Type | Example | Purpose |
|---|---|---|---|
| `role` | enum | `coder`, `reviewer`, `orchestrator`, `custom` | Bucket the agent into a routing pattern |
| `responsibility` | text | "Issue'ları implement eder, commit atar, push yapar" | Free-form 1-2 sentence for prompt injection |
| `handoff_rules` | JSON | `[{when:"changes_requested",to_role:"coder",template:"Apply: {output}"}]` | What to do when this agent finishes |

CLI:
```
foreman agent role codex coder
foreman agent responsibility codex "Implement issues, commit per PR, push to GitHub"
foreman agent handoff codex --when code_written --to-role reviewer --template "Review this: {summary}"
```

Wizard adds prompts at install time so fresh setups auto-configure
sensible defaults (codex=coder, claude-code=reviewer, hermes=orchestrator).

### 2. Flow data model

New tables:

```sql
CREATE TABLE flows (
  id TEXT PRIMARY KEY,             -- ULID
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL,            -- 'active' | 'completed' | 'halted'
  initiator TEXT,                  -- source_user from the originating write
  goal TEXT NOT NULL,              -- the original user task text
  current_holder TEXT,             -- agent_id currently working (NULL when idle)
  final_summary TEXT,              -- orchestrator-produced summary when status=completed
  cost_usd REAL DEFAULT 0          -- rolled up from llm_usage rows
);

CREATE TABLE flow_steps (
  id TEXT PRIMARY KEY,             -- ULID
  flow_id TEXT NOT NULL REFERENCES flows(id),
  parent_step_id TEXT REFERENCES flow_steps(id),   -- NULL for root
  step_order INTEGER NOT NULL,
  source_agent TEXT,               -- NULL for user-initiated root
  target_agent TEXT NOT NULL,
  directive_id INTEGER REFERENCES control_commands(id),
  intent TEXT NOT NULL,            -- 'implement' | 'review' | 'fix' | 'summarize' | 'custom'
  output_classification TEXT,      -- what the classifier decided this output was
  output_summary TEXT,             -- short summary of the output (for flow tree)
  status TEXT NOT NULL,            -- 'pending' | 'running' | 'completed' | 'failed'
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX idx_flow_steps_flow ON flow_steps(flow_id);
CREATE INDEX idx_flows_status ON flows(status);
```

### 3. Routing engine

`src/core/flow-router.ts`:

```typescript
export interface FlowRouter {
  /** Called from executeWriteDirective after spawn completes.
   *  Decides whether to continue the flow, terminate, or escalate. */
  routeAfterCompletion(args: {
    flowId: string | null;        // null if not part of a flow yet
    stepId: string | null;
    sourceAgent: string;
    spawn: SpawnAgentTaskOutcome;
    output: string;               // captured stdout
  }): Promise<RoutingDecision>;
}

type RoutingDecision =
  | { kind: 'forward'; toAgent: string; intent: string; prompt: string; flowId: string }
  | { kind: 'finalize'; flowId: string; summary: string }
  | { kind: 'escalate_to_user'; reason: string }
  | { kind: 'continue_idle' };    // not a flow, current behavior
```

Routing logic per completion:
1. If `flowId` is null, this is a one-shot write — current behavior, output to user.
2. Else, classify the output (Phase B: LLM; Phase A fallback: heuristic regex):
   - "code_written_and_committed" / "code_written"
   - "changes_requested"
   - "approved"
   - "blocked"
   - "summary_ready"
3. Lookup `handoff_rules` for `sourceAgent` where `when` matches the classification.
4. If matched: forward to the rule's `to_role` (resolve to a concrete agent_id),
   inject the rule's `template` as the new task text, enqueue a write directive,
   return `forward`.
5. If no match and source is NOT orchestrator: forward to orchestrator with
   intent="summarize" so hermes synthesizes the final user-facing summary.
6. If source IS orchestrator OR explicit "user_summary" classification: `finalize`
   — write the orchestrator's summary into `flows.final_summary`, emit
   `flow:completed` event, single Telegram push.

### 4. Output classification

**Phase A (heuristic):** `src/core/flow-classifier-heuristic.ts`
- Regex matchers on the captured stdout.
- Patterns built from observed agent outputs:
  - `changes_requested`: presence of "changes requested", "blocker", "fix the following", "⚠️", "must"
  - `approved`: "approved", "lgtm", "looks good", "ready to merge", "✅"
  - `blocked`: "cannot", "permission denied", "unable to", "failed"
  - `code_written_and_committed`: "commit hash:", "pushed to", "git log shows"
  - `code_written`: presence of file path mentions + "implemented" / "added"

**Phase B (LLM):** `src/core/llm/output-classifier.ts`
- Uses existing LlmVerifier infrastructure
- Prompt template: given output text + handoff_rules.when keys, classify
- Returns structured JSON: `{classification, confidence, reasoning}`
- Caches by output hash
- Falls back to heuristic when feature disabled / budget out

Decision: **start with heuristic, layer in LLM in Phase B once Phase A is shipping clean.**

### 5. User visibility

#### CLI

```
$ foreman flow list
ID         GOAL                       PARTICIPANTS                STATUS   STEPS
01HZX01    to-do-app issues #1-5      codex → claude → codex      active   3/?
01HZW99    refactor auth              claude → codex              done     5/5

$ foreman flow show 01HZX01
Flow 01HZX01 — "to-do-app issues #1-5"
Status: active (12m elapsed)
Cost: $0.18

  ▶ root → codex (implement, 7m 9s, completed)
      └─ output: 8 files, no commit (blocker: .git permissions)
      ▶ codex → claude (review, 5m 20s, completed)
          └─ classification: changes_requested
          └─ output: review report with 4 minor + 2 blocker items
          ▶ claude → codex (fix, 2m elapsed, running)
              └─ awaiting completion
```

#### TUI

New tab "Flows" in the TUI:
- Top: list of active flows
- Bottom (when one selected): step tree with live progress
- Single key (`f`) to jump to Flows from anywhere

#### Telegram

Phase A: per-step pushes stay (current behavior) but tagged with flow id.
Phase C: **single-thread mode** — all flow updates edit a single message rather
than spawning new ones. Only the final completion creates a fresh message
with the orchestrator's summary.

Default after Phase C: silent until completion, just the final summary push.
Opt-in `foreman flow watch <id>` re-enables per-step pushes for that flow.

### 6. Hermes prompt update

Hermes's identity-template currently has no concept of "flow" or "responsibility
chain". Add a section that teaches:
- When a user issues a multi-step goal, Hermes calls `foreman start-flow <goal>`
  instead of directly spawning N parallel writes.
- Hermes provides the goal text + (optionally) a participants list.
- Foreman returns a flow_id; Hermes reports it back to user.
- Subsequent agent-to-agent routing is Foreman's job, not Hermes's.

## Phase plan

| Phase | Scope | Status |
|---|---|---|
| 0 | Codex sandbox fix (this PR commit 1) | ✅ Committed |
| A.1 | Schema migration + new tables | ⏳ Next |
| A.2 | `FlowManager` core + `FlowRouter` (heuristic classifier) | ⏳ |
| A.3 | Hook into `executeWriteDirective` post-spawn | ⏳ |
| A.4 | CLI: `foreman flow list/show` + `foreman agent role/responsibility/handoff` | ⏳ |
| A.5 | Default catalog handoff_rules for codex/claude-code/hermes | ⏳ |
| B.1 | LLM classifier (`src/core/llm/output-classifier.ts`) | ⏳ |
| B.2 | Heuristic → LLM fallback chain + budget integration | ⏳ |
| C.1 | TUI Flows tab | ⏳ |
| C.2 | Telegram single-thread edit-in-place mode | ⏳ |
| C.3 | Notification template: `flow_completed` summary | ⏳ |
| D.1 | Wizard role/responsibility prompts at install | ⏳ |
| D.2 | Hermes identity-template update | ⏳ |
| E | Tests across all phases (target ≥ 50 new tests, no regression on 3236 baseline) | ⏳ |
| F | README + this doc finalization + PR open | ⏳ |

Estimated work: 3-4 focused sessions.

## Out of scope (future PRs)

- Multi-flow concurrency arbitration (when two flows want the same agent at
  once). Phase A serializes per agent; future PR adds queueing + priority.
- Conditional branches (if/else in handoff_rules). Phase A is strict
  classification → first matching rule wins.
- Cross-machine flows (when codex runs on machine A, claude on machine B).
  Phase A assumes single-host orchestration.
- Hermes peer-to-peer override (Hermes deciding mid-flow to bypass routing).
  Phase A: Foreman owns routing; Hermes is just the chat surface + initiator.

## Open design questions

1. **Cycle detection.** What stops codex ↔ claude from looping forever if
   claude keeps requesting changes? Proposal: max 5 round-trips per flow,
   then auto-escalate to user. Configurable per flow.
2. **Cost ceiling per flow.** Should `flows` have a budget that halts the
   flow when exceeded? Proposal: yes, default $1, configurable.
3. **User intervention.** Can the user mid-flow say "skip claude" or "approve
   anyway"? Proposal: `foreman flow override <id> <directive>` injects a
   user directive into the next step.
4. **Resumability.** If Foreman restarts mid-flow, do we resume? Proposal:
   flows table persists everything; on restart, scan for status=active
   flows and re-enqueue the pending step.

These are filed as TODO comments to be resolved during Phase A.2 + A.3.
