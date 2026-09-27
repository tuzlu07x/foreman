import type { TokenCounts } from "./pricing.js";

// =============================================================================
// Usage lines printed by an agent CLI at the end of a task (#629)
// =============================================================================
//
// A fallback for agents without telemetry. Two shapes are recognised:
//   - a JSON result with `usage` / `total_cost_usd` (e.g. `claude --print
//     --output-format json`);
//   - a `tokens used` line (e.g. `codex exec`), which only gives a total.
// Anything else yields null: Foreman never guesses a number.

export interface TaskUsage extends TokenCounts {
  model?: string;
  costUsd?: number;
}

export function parseTaskUsage(stdout: string, stderr = ""): TaskUsage | null {
  return fromJsonResult(stdout) ?? fromTokensUsedLine(`${stdout}\n${stderr}`);
}

function fromJsonResult(stdout: string): TaskUsage | null {
  const text = stdout.trim();
  if (!text.startsWith("{") && !text.includes("\n{")) return null;
  const candidates = [text, text.slice(text.lastIndexOf("\n{") + 1)];
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    const usage = typeof obj.usage === "object" && obj.usage !== null ? (obj.usage as Record<string, unknown>) : null;
    const cost = num(obj.total_cost_usd) ?? num(obj.cost_usd);
    if (!usage && cost === undefined) continue;
    const modelUsage =
      typeof obj.modelUsage === "object" && obj.modelUsage !== null ? Object.keys(obj.modelUsage) : [];
    const out: TaskUsage = {
      ...(usage
        ? {
            input: num(usage.input_tokens) ?? 0,
            output: num(usage.output_tokens) ?? 0,
            cacheRead: num(usage.cache_read_input_tokens) ?? 0,
            cacheWrite: num(usage.cache_creation_input_tokens) ?? 0,
          }
        : {}),
      ...(cost !== undefined ? { costUsd: cost } : {}),
      ...(typeof obj.model === "string" ? { model: obj.model } : modelUsage[0] ? { model: modelUsage[0] } : {}),
    };
    return out;
  }
  return null;
}

const TOKENS_USED = /tokens used[:\s]*([\d][\d,._ ]*)/gi;

function fromTokensUsedLine(text: string): TaskUsage | null {
  let last: string | null = null;
  for (const m of text.matchAll(TOKENS_USED)) last = m[1] ?? null;
  if (!last) return null;
  const total = Number(last.replace(/[,._ ]/g, ""));
  return Number.isFinite(total) && total > 0 ? { total } : null;
}

function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}
