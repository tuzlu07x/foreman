import { stripControl } from "../inbox.js";
import { redactSecretShapes } from "../risk-rules/secret-patterns.js";

// =============================================================================
// Text that agents control, made safe to show inside Foreman's own lines
// =============================================================================
//
// Approval reviews (#623) put agent-supplied text (a reason, a tool name, an
// agent id, tool arguments) inside lines Foreman writes: the `[review]`
// message, the TUI approval screen, chat follow-ups. Each such field is one
// line, with no bidi or zero-width tricks, secrets redacted and a length
// cap, so it can't pass off a line of its own ("[a] allow once") or push
// the real key hints off screen.

/** Bidi controls, zero-width characters, BOM, and the line / paragraph
 *  separators some renderers treat as newlines. */
const INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2069\ufeff]/g;

/** One line: invisible characters dropped, every run of whitespace
 *  (newlines and tabs too) collapsed to a space, control characters
 *  stripped, secrets redacted, clipped to `max`. */
export function singleLine(text: string, max: number): string {
  const flat = stripControl(text.replace(INVISIBLE, "").replace(/\s+/g, " "));
  const redacted = redactSecretShapes(flat).text.replace(/\s+/g, " ").trim();
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

/** A single-line field in double quotes, for Foreman-written lines. */
export function quoted(text: string, max = 80): string {
  return JSON.stringify(singleLine(text, max));
}

const MASK = "[redacted]";
/** Keys whose values are never shown, whatever they look like. */
const SENSITIVE_KEY = /pass|secret|token|key|auth|cookie|credential|session/i;
const MAX_DEPTH = 8;

/** Mask values under sensitive keys, at any depth. */
export function maskSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return MASK;
  if (Array.isArray(value)) return value.map((v) => maskSensitive(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? MASK : maskSensitive(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** `Bearer <opaque>` / `Basic <opaque>` anywhere in a string. */
const AUTH_SCHEME = /\b(bearer|basic)\s+[^\s"'\\,;]{4,}/gi;
/** `password=…`, `token: …`, `--api-key=…` and friends inside a string. */
const SENSITIVE_PAIR =
  /\b((?:[a-z0-9_-]*(?:pass(?:word|wd)?|secret|token|api[-_]?key|auth[a-z]*|cookie|credentials?|session[-_]?id)[a-z0-9_-]*)\s*[:=]\s*)(\\?"?)[^\s"'\\&,;]+/gi;

/** Tool arguments as one clipped line: sensitive keys masked, auth
 *  headers and `key=value` secrets inside strings masked, known secret
 *  shapes redacted. Unknown shapes under innocent keys can still get
 *  through; callers must say so. */
export function renderArgsForReview(args: unknown, max: number): string {
  if (args === undefined || args === null) return "(none)";
  let text: string;
  try {
    text = JSON.stringify(maskSensitive(args)) ?? String(args);
  } catch {
    text = String(args);
  }
  const masked = text.replace(AUTH_SCHEME, `$1 ${MASK}`).replace(SENSITIVE_PAIR, `$1$2${MASK}`);
  return singleLine(masked, max);
}
