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

// List prices checked 2026-09-28 against each provider's pricing page.
const PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-3-7-sonnet": { input: 3, output: 15 },
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-haiku-4": { input: 1, output: 5 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "gpt-6-astra": { input: 10, output: 50 },
  "gpt-6-sol": { input: 2, output: 10 },
  "gpt-6-luna": { input: 0.1, output: 0.5 },
  "gpt-5.6-sol": { input: 4, output: 20 },
  "gpt-5.6-terra": { input: 2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gpt-5.5-pro": { input: 30, output: 180 },
  "gpt-5.5": { input: 5, output: 30 },
  "gpt-5.4-pro": { input: 30, output: 180 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.4": { input: 2.5, output: 15 },
  "gpt-5.2-pro": { input: 21, output: 168 },
  "gpt-5.2": { input: 1.75, output: 14 },
  "gpt-5.1": { input: 1.25, output: 10 },
  "gpt-5-pro": { input: 15, output: 120 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "o3-pro": { input: 20, output: 80 },
  "o3-mini": { input: 1.1, output: 4.4 },
  o3: { input: 2, output: 8 },
  "o1-mini": { input: 3, output: 12 },
  "o1-pro": { input: 150, output: 600 },
  o1: { input: 15, output: 60 },
  "codex-mini": { input: 1.5, output: 6 },
  "gemini-3.8-flash": { input: 1.5, output: 7.5 },
  "gemini-3.7-flash": { input: 1.5, output: 7.5 },
  "gemini-3.6-flash": { input: 1.5, output: 7.5 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini-3.5-flash": { input: 1.5, output: 9 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  "gemini-3.1-pro": { input: 2, output: 12 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
};

const PREFIXES = Object.keys(PRICES).sort((a, b) => b.length - a.length);

export function priceFor(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const name = model
    .trim()
    .toLowerCase()
    .replace(/^(anthropic|openai|google)\//, "");
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
export function estimateCost(
  model: string | null | undefined,
  t: TokenCounts,
): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const perToken = (usdPerMillion: number): number => usdPerMillion / 1_000_000;
  const split =
    (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
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
