// =============================================================================
// LLM debug logging (#347)
// =============================================================================
//
// QA round 3: the TUI modal shows `Smart analysis temporarily unavailable
// (provider error). Heuristic-only.` even when `foreman llm test` succeeds
// against the same provider. The verifier + summary narrator catch every
// LlmProviderError and reduce it to a generic "skipped" reason, so the
// actual cause (4xx body, rate-limit, malformed prompt response) never
// reaches the user — they can't tell whether the key is wrong, the model
// is mis-named, or the prompt itself blew up.
//
// Opt-in: set `FOREMAN_LLM_DEBUG=1` and the next failure prints a single
// stderr line `[foreman llm:<context>] <error message>`. No timestamps,
// no stack traces — keep it tight so it's grep-friendly without flooding
// the TUI. Off by default so production output stays quiet.

export interface LlmDebugEnv {
  /** Override for tests. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override the writer for tests. Defaults to `process.stderr.write`. */
  write?: (line: string) => void;
}

export function isLlmDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.FOREMAN_LLM_DEBUG;
  if (!flag) return false;
  const normalized = flag.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * Emit one stderr line when FOREMAN_LLM_DEBUG is set. Otherwise no-op.
 * `context` is a short tag like "verifier", "summary", "budget".
 */
export function debugLogLlmError(
  context: string,
  err: unknown,
  opts: LlmDebugEnv = {},
): void {
  if (!isLlmDebugEnabled(opts.env)) return;
  const message = err instanceof Error ? err.message : String(err);
  const write = opts.write ?? ((line: string) => process.stderr.write(line));
  write(`[foreman llm:${context}] ${message}\n`);
}
