// =============================================================================
// Model prices — only for sources that report tokens without a cost
// =============================================================================
//
// Claude Code's telemetry carries the real cost of every request, and that
// always wins. Codex and task output report tokens only, so Foreman estimates
// from this table and marks the result as estimated (≈ in reports).
//
// USD per million tokens. Matched by the longest prefix of the model name,
// case-insensitively. An unknown model is not guessed: its cost stays 0 and
// the report says so.

export interface ModelPrice {
  input: number;
  output: number;
  /** Cache reads; defaults to 10% of input. */
  cacheRead?: number;
  /** Cache writes; defaults to 125% of input. */
  cacheWrite?: number;
}

const PRICES: Record<string, ModelPrice> = {
  "claude-opus-4": { input: 15, output: 75 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-3-7-sonnet": { input: 3, output: 15 },
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-haiku-4": { input: 1, output: 5 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "o3": { input: 2, output: 8 },
  "codex-mini": { input: 1.5, output: 6 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
};

const PREFIXES = Object.keys(PRICES).sort((a, b) => b.length - a.length);

export function priceFor(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const name = model.trim().toLowerCase().replace(/^(anthropic|openai|google)\//, "");
  const hit = PREFIXES.find((p) => name.startsWith(p));
  return hit ? PRICES[hit]! : null;
}

export interface TokenCounts {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Only a total is known (e.g. Codex's `tokens used: N`). */
  total?: number;
}

/** Estimated USD cost, or null when the model is unknown. */
export function estimateCost(model: string | null | undefined, t: TokenCounts): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const perToken = (usdPerMillion: number): number => usdPerMillion / 1_000_000;
  const split = (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
  if (split === 0 && t.total) {
    // Only a total: assume the usual 3:1 input-to-output mix of agent work.
    return t.total * (0.75 * perToken(p.input) + 0.25 * perToken(p.output));
  }
  return (
    (t.input ?? 0) * perToken(p.input) +
    (t.output ?? 0) * perToken(p.output) +
    (t.cacheRead ?? 0) * perToken(p.cacheRead ?? p.input * 0.1) +
    (t.cacheWrite ?? 0) * perToken(p.cacheWrite ?? p.input * 1.25)
  );
}
