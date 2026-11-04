import type { ControlCommand } from "../db/schema.js";
import type { DelegationSpawn } from "./inbox.js";
import { redactSecretShapes } from "./risk-rules/secret-patterns.js";

// =============================================================================
// Telling the person who asked that the work is done
// =============================================================================
//
// You ask from Telegram, Slack or Discord and go away, so the answer comes
// back to the same place: one message for a task, and one for a whole plan
// once every step has ended, whatever became of each. Only tasks a person
// asked for: what agents hand each other stays in their own threads.

const CHAT_APPS: ReadonlySet<string> = new Set(["telegram", "slack", "discord"]);
const MAX_LINE = 280;

export type TellChannel = (channel: string, title: string, body: string) => void;

interface Outcome {
  ok: boolean;
  text: string;
}

interface PlanRows {
  channel: string;
  /** In plan order. */
  ids: number[];
  lines: Map<number, string>;
}

export class TaskReports {
  private readonly outcomes = new Map<number, Outcome>();
  private readonly plans = new Map<number, PlanRows>();

  constructor(private readonly tell: TellChannel) {}

  /** Whether this task is reported back to a chat app when it ends. */
  handles(row: Pick<ControlCommand, "command" | "sourceAgent">): boolean {
    return row.command === "write" && CHAT_APPS.has(row.sourceAgent);
  }

  /** A plan asked for in `channel`: call the result with each row it queues. */
  plan(channel: string): (id: number) => void {
    const plan: PlanRows = { channel, ids: [], lines: new Map() };
    return (id) => {
      plan.ids.push(id);
      this.plans.set(id, plan);
    };
  }

  /** What became of a run, from the task's own handler. */
  note(id: number, input: { spawn: DelegationSpawn; handedOn: boolean }): void {
    this.outcomes.set(id, outcomeOf(input.spawn, input.handedOn));
  }

  /** A row reached its final status (control:applied / control:failed). */
  settled(row: ControlCommand): void {
    if (!this.handles(row)) return;
    const agent = agentOf(row);
    const outcome = this.outcomes.get(row.id) ?? { ok: row.status === "applied", text: clean(row.error ?? "") };
    this.outcomes.delete(row.id);
    const plan = this.plans.get(row.id);
    if (!plan) {
      this.tell(row.sourceAgent, outcome.ok ? `${agent} finished` : `${agent} didn't finish`, outcome.text);
      return;
    }
    this.plans.delete(row.id);
    plan.lines.set(row.id, `${outcome.ok ? "✓" : "✗"} ${agent}: ${outcome.text}`);
    if (plan.lines.size < plan.ids.length) return;
    const lines = plan.ids.map((id) => plan.lines.get(id)!);
    const allOk = lines.every((line) => line.startsWith("✓"));
    this.tell(plan.channel, allOk ? "Plan finished" : "Plan finished with problems", lines.join("\n\n"));
  }
}

function agentOf(row: Pick<ControlCommand, "args">): string {
  try {
    const [agent] = JSON.parse(row.args) as unknown[];
    return typeof agent === "string" && agent ? agent : "task";
  } catch {
    return "task";
  }
}

function outcomeOf(spawn: DelegationSpawn, handedOn: boolean): Outcome {
  switch (spawn.kind) {
    case "ok": {
      const said = clean(spawn.stdout) || "(no output)";
      return { ok: true, text: handedOn ? `handed it on. ${said}` : said };
    }
    case "failed":
      return { ok: false, text: clean(spawn.stderr || spawn.stdout) || `exit ${spawn.exitCode}` };
    case "timeout":
      return { ok: false, text: `stopped after ${Math.round(spawn.timeoutMs / 1000)}s` };
    case "spawn-error":
      return { ok: false, text: clean(spawn.error) };
    default:
      return { ok: false, text: clean(spawn.reason) };
  }
}

/** The end of what an agent said, on one line, with secrets out. */
function clean(text: string): string {
  const tail = text.trim().split("\n").slice(-4).join(" ").replace(/\s+/g, " ").trim();
  const safe = redactSecretShapes(tail).text;
  return safe.length > MAX_LINE ? `${safe.slice(0, MAX_LINE - 1)}…` : safe;
}
