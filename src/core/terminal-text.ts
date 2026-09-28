// =============================================================================
// Agent-controlled text on a terminal (#656)
// =============================================================================
//
// Paths, tool names, agent ids and arguments come from agents. Printed raw,
// an escape sequence can erase or recolour the line around it (`ESC[2K`,
// `CR`, SGR 8 "concealed"), retitle the terminal (OSC) or clear the screen,
// and bidi or zero-width characters can make `.env` read as `vne.`. That
// turns the approval prompt into a place to lie to you.
//
// Everything an agent supplied goes through `terminalSafe` right where it
// is displayed (TUI and CLI). Nothing is silently dropped: each hidden
// character becomes a visible stand-in, so you can see that something odd
// is there. The same character set the org messages and the inbox strip
// (inbox.ts `stripControl`, org/text.ts) is covered here.

/** Bidi controls, zero-width characters, BOM, line / paragraph separators
 *  and Unicode tag characters: invisible, but they change what you read. */
const INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2069\ufeff]|[\u{e0000}-\u{e007f}]/u;

/** C0 controls, DEL and C1 controls. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const ANY_HIDDEN = new RegExp(`${CONTROL.source}|${INVISIBLE.source}`, "gu");

export interface TerminalSafeOptions {
  /** Keep `\n` (and `\t`) as they are, for multi-line text. By default a
   *  newline is shown as `␊` so one field can't start a line of its own. */
  multiline?: boolean;
}

/** Text an agent controls, safe to print: every control, escape, bidi or
 *  zero-width character is replaced by a visible stand-in (`ESC` → `␛`,
 *  `CR` → `␍`, C1 → `\x9b`, U+202E → `⟨U+202E⟩`). */
export function terminalSafe(text: string, opts: TerminalSafeOptions = {}): string {
  return text.replace(ANY_HIDDEN, (ch) => {
    const code = ch.codePointAt(0)!;
    if (opts.multiline && (ch === "\n" || ch === "\t")) return ch;
    if (code <= 0x1f) return String.fromCodePoint(0x2400 + code);
    if (code === 0x7f) return "␡";
    if (code <= 0x9f) return `\\x${code.toString(16).padStart(2, "0")}`;
    return `⟨U+${code.toString(16).toUpperCase().padStart(4, "0")}⟩`;
  });
}

/** True when `terminalSafe` would change `text`. */
export function hasHiddenCharacters(text: string): boolean {
  ANY_HIDDEN.lastIndex = 0;
  const hit = ANY_HIDDEN.test(text);
  ANY_HIDDEN.lastIndex = 0;
  return hit;
}

/** JSON for a terminal: `JSON.stringify` already escapes C0 controls, but
 *  leaves C1, bidi and zero-width characters raw. Those become `\uXXXX`
 *  escapes too, so the output is still valid JSON and prints safely. */
export function jsonForTerminal(value: unknown, space?: number): string {
  const text = JSON.stringify(value, null, space) ?? "null";
  return text.replace(ANY_HIDDEN, (ch) =>
    ch === "\n"
      ? ch
      : Array.from({ length: ch.length }, (_, i) => `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""),
  );
}
