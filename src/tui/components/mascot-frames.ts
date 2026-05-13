export type MascotSize = "large" | "medium" | "small";

export interface MascotFrame {
  lines: string[];
  width: number;
  height: number;
}

const NORMAL_LINES: readonly string[] = [
  "    ▄▄▄▄▄▄▄▄▄",
  "   ▟▀▀▀F▀▀▀▙",
  "   ▐▓▓▓▓▓▓▓▌",
  "  ▐▓ ●   ● ▓▌",
  "   ▐▓  ▼  ▓▌",
  "    ▝▟▀▀▀▙▘",
  "   ▟▒▒▒▒▒▒▒▙",
  "  ▐██▓VEST▓██▌",
  "  ▐██▒▒▒▒▒██▌",
  "   ▝▀▀▀▀▀▀▀▘",
];

const BLINK_LINES: readonly string[] = [
  "    ▄▄▄▄▄▄▄▄▄",
  "   ▟▀▀▀F▀▀▀▙",
  "   ▐▓▓▓▓▓▓▓▌",
  "  ▐▓ ─   ─ ▓▌",
  "   ▐▓  ▼  ▓▌",
  "    ▝▟▀▀▀▙▘",
  "   ▟▒▒▒▒▒▒▒▙",
  "  ▐██▓VEST▓██▌",
  "  ▐██▒▒▒▒▒██▌",
  "   ▝▀▀▀▀▀▀▀▘",
];

export const MORPH_GLYPHS: readonly string[] = ["░", "▒", "▓", "█"];

export function blockFallbackFrame(blink: boolean): MascotFrame {
  const lines = blink ? [...BLINK_LINES] : [...NORMAL_LINES];
  return {
    lines,
    width: Math.max(...lines.map((l) => [...l].length)),
    height: lines.length,
  };
}

export function buildMorphFrame(
  target: readonly string[],
  glyphIdx: number,
): string[] {
  const glyph = MORPH_GLYPHS[glyphIdx] ?? MORPH_GLYPHS[MORPH_GLYPHS.length - 1];
  return target.map((line) =>
    [...line].map((ch) => (ch === " " ? " " : glyph)).join(""),
  );
}

export function pickChafaSize(termCols: number): {
  cols: number;
  rows: number;
  asset: string;
} {
  if (termCols >= 100) {
    return { cols: 36, rows: 18, asset: "terminal-large.png" };
  }
  if (termCols >= 60) {
    return { cols: 24, rows: 12, asset: "terminal-medium.png" };
  }
  return { cols: 16, rows: 8, asset: "terminal-small.png" };
}

export function pickChafaBlinkAsset(termCols: number): string | null {
  if (termCols >= 100) return "terminal-large-blink.png";
  if (termCols >= 60) return "terminal-medium-blink.png";
  return null;
}
