import type { Request } from "../db/schema.js";

export interface DecisionStats {
  allowed: number;
  denied: number;
  pending: number;
  total: number;
}

export function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Human-friendly relative time (#234 UX-10). Used in the activity feed so a
 *  row reads "12s ago" / "3m ago" / "2h ago" / "5d ago" instead of an
 *  absolute HH:MM:SS stamp that needs mental math at a glance. */
export function relativeTime(
  epochMs: number,
  now: number = Date.now(),
): string {
  const deltaMs = Math.max(0, now - epochMs);
  if (deltaMs < 5_000) return "just now";
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function statusIconFor(decision: "allowed" | "denied" | "pending"): {
  icon: string;
  tone: "success" | "danger" | "warning";
} {
  if (decision === "allowed") return { icon: "✓", tone: "success" };
  if (decision === "denied") return { icon: "✗", tone: "danger" };
  return { icon: "⚠", tone: "warning" };
}

export function summariseTool(tool: string | null, argsJson: string): string {
  if (!tool) return "(no tool)";
  const args = parseArgs(argsJson);
  const inline = formatArgsInline(args);
  return `${tool}(${inline})`;
}

export function targetLabel(
  sourceAgent: string,
  targetAgent: string | null,
): string {
  return targetAgent ? `${sourceAgent} → ${targetAgent}` : sourceAgent;
}

export function aggregateStats(
  requests: Pick<Request, "decision">[],
): DecisionStats {
  const out: DecisionStats = { allowed: 0, denied: 0, pending: 0, total: 0 };
  for (const r of requests) {
    out.total++;
    if (r.decision === "allowed") out.allowed++;
    else if (r.decision === "denied") out.denied++;
    else out.pending++;
  }
  return out;
}

export function percentBar(value: number, total: number, width = 12): string {
  if (total === 0) return "·".repeat(width);
  const ratio = Math.max(0, Math.min(1, value / total));
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "·".repeat(width - filled);
}

export function percentLabel(value: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}

export function startOfTodayMs(now: number = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function parseArgs(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function formatArgsInline(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return JSON.stringify(args);
  const obj = args as Record<string, unknown>;
  if (typeof obj.path === "string") return `"${obj.path}"`;
  if (typeof obj.text === "string") return `"${truncate(obj.text, 32)}"`;
  const keys = Object.keys(obj);
  if (keys.length === 0) return "";
  if (keys.length === 1) {
    const k = keys[0]!;
    return `${k}=${JSON.stringify(obj[k])}`;
  }
  return `…${keys.length} args`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}
