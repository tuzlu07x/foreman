export interface TokenPrice {
  input: number;
  output: number;
}

/** Suffixes that name a snapshot of a priced model, not a different model. */
const SNAPSHOT_SUFFIX =
  /^(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{3}|latest|preview(?:-[a-z0-9-]+)?)$/;

function normalise(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^models\//, "");
}

/** The table row for `model`, or undefined when it isn't priced. */
export function lookupPrice(
  table: Readonly<Record<string, TokenPrice>>,
  model: string,
): TokenPrice | undefined {
  const name = normalise(model);
  const exact = table[name];
  if (exact) return exact;
  let best: string | undefined;
  for (const key of Object.keys(table)) {
    if (!name.startsWith(`${key}-`)) continue;
    if (!SNAPSHOT_SUFFIX.test(name.slice(key.length + 1))) continue;
    if (!best || key.length > best.length) best = key;
  }
  return best ? table[best] : undefined;
}

export function costUsd(
  price: TokenPrice,
  inputTokens: number,
  outputTokens: number,
): number {
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
