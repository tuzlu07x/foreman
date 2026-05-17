// =============================================================================
// TUI design tokens (#234 — UX-1 / UX-3)
// =============================================================================
//
// Single source of truth for every color, symbol and border style the TUI
// renders. Components must NEVER use raw hex / color names — pull from
// `theme.*` so:
//
//   1) Palette stays consistent across pages
//   2) FOREMAN_ASCII=1 can swap unicode glyphs for ASCII fallbacks
//   3) FOREMAN_HIGH_CONTRAST=1 can boost the palette for accessibility
//
// `theme` is computed once at module load by reading the env. That's fine
// for the TUI's lifetime (no live theme switching). Tests can hit the
// `buildTheme()` factory directly to assert all three modes.

import type { RiskBucket } from "../core/risk-rules/types.js";

export interface ColorScale {
  primary: string;
  primaryAlt: string;
  success: string;
  danger: string;
  warning: string;
  info: string;
}

export interface Palette {
  accent: ColorScale;
  fg: { default: string; muted: string; emphasis: string };
  bg: { elevated: string };
  /** Severity-bound colors for the approval modal + log/sessions rows. */
  risk: { low: string; medium: string; high: string; critical: string };
}

export interface SymbolSet {
  bullet: string;
  check: string;
  cross: string;
  warn: string;
  activeDot: string;
  idleDot: string;
  reason: string;
  timer: string;
  info: string;
  subBullet: string;
  arrow: string;
  cursor: string;
  loading: string;
}

export interface ThemeSpec {
  accent: ColorScale;
  fg: Palette["fg"];
  bg: Palette["bg"];
  risk: Palette["risk"];
  symbols: SymbolSet;
}

// -----------------------------------------------------------------------------
// Palettes
// -----------------------------------------------------------------------------

const DEFAULT_PALETTE: Palette = {
  accent: {
    primary: "#FF8C42",
    primaryAlt: "#FFB52E",
    success: "#00D084",
    danger: "#FF5252",
    warning: "#FFC542",
    info: "#4D9DE0",
  },
  fg: {
    default: "#E8E8E8",
    muted: "#7A7A7A",
    emphasis: "#FFFFFF",
  },
  bg: { elevated: "#1E1E1E" },
  risk: {
    low: "#00D084",
    medium: "#FFC542",
    high: "#FF8C42",
    critical: "#FF5252",
  },
};

// High-contrast variant: brighter colors, plus pure white for emphasis and
// brighter foreground so subtitle text stays legible on low-end terminals.
const HIGH_CONTRAST_PALETTE: Palette = {
  accent: {
    primary: "#FFAA66",
    primaryAlt: "#FFD144",
    success: "#00FFA6",
    danger: "#FF7373",
    warning: "#FFE066",
    info: "#73B8FF",
  },
  fg: {
    default: "#FFFFFF",
    muted: "#C8C8C8",
    emphasis: "#FFFFFF",
  },
  bg: { elevated: "#0A0A0A" },
  risk: {
    low: "#00FFA6",
    medium: "#FFE066",
    high: "#FFAA66",
    critical: "#FF7373",
  },
};

// -----------------------------------------------------------------------------
// Symbols — Unicode + ASCII fallbacks (FOREMAN_ASCII=1)
// -----------------------------------------------------------------------------

const UNICODE_SYMBOLS: SymbolSet = {
  bullet: "▸",
  check: "✓",
  cross: "✗",
  warn: "⚠",
  activeDot: "●",
  idleDot: "○",
  reason: "◆",
  timer: "⏱",
  info: "▸",
  subBullet: "◦",
  arrow: "→",
  cursor: "❯",
  loading: "⟳",
};

const ASCII_SYMBOLS: SymbolSet = {
  bullet: ">",
  check: "+",
  cross: "x",
  warn: "!",
  activeDot: "*",
  idleDot: "o",
  reason: "@",
  timer: "T",
  info: ">",
  subBullet: "-",
  arrow: "->",
  cursor: ">",
  loading: "/",
};

// -----------------------------------------------------------------------------
// Theme factory
// -----------------------------------------------------------------------------

export interface BuildThemeOptions {
  ascii?: boolean;
  highContrast?: boolean;
}

export function buildTheme(opts: BuildThemeOptions = {}): ThemeSpec {
  const palette = opts.highContrast ? HIGH_CONTRAST_PALETTE : DEFAULT_PALETTE;
  const symbols = opts.ascii ? ASCII_SYMBOLS : UNICODE_SYMBOLS;
  return {
    accent: palette.accent,
    fg: palette.fg,
    bg: palette.bg,
    risk: palette.risk,
    symbols,
  };
}

export function isAsciiMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FOREMAN_ASCII === "1";
}

export function isHighContrast(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FOREMAN_HIGH_CONTRAST === "1";
}

// Module-level theme: components import `theme` and get the env-resolved one.
// Compute once at load — TUI doesn't hot-reload theme.
export const theme: ThemeSpec = buildTheme({
  ascii: isAsciiMode(),
  highContrast: isHighContrast(),
});

export type Theme = typeof theme;

// -----------------------------------------------------------------------------
// Risk helpers — centralised so every component renders the same severity
// the same way. Use these instead of inline switches.
// -----------------------------------------------------------------------------

export function riskColor(bucket: RiskBucket): string {
  switch (bucket) {
    case "critical":
      return theme.risk.critical;
    case "high":
      return theme.risk.high;
    case "medium":
      return theme.risk.medium;
    case "low":
    default:
      return theme.risk.low;
  }
}

// Emoji-based risk dots (used in the security report verdict, modal). ASCII
// mode falls back to single-char tones so the dot still reads as severity
// without unicode.
export function riskIcon(bucket: RiskBucket): string {
  if (isAsciiMode()) {
    switch (bucket) {
      case "critical":
        return "X";
      case "high":
        return "!";
      case "medium":
        return "?";
      case "low":
      default:
        return ".";
    }
  }
  switch (bucket) {
    case "critical":
      return "🔴";
    case "high":
      return "🟠";
    case "medium":
      return "🟡";
    case "low":
    default:
      return "🟢";
  }
}

// -----------------------------------------------------------------------------
// Border styles — same Unicode/ASCII split as before
// -----------------------------------------------------------------------------

const ASCII_SINGLE = {
  topLeft: "+",
  top: "-",
  topRight: "+",
  right: "|",
  bottomRight: "+",
  bottom: "-",
  bottomLeft: "+",
  left: "|",
} as const;

const ASCII_DOUBLE = {
  topLeft: "+",
  top: "=",
  topRight: "+",
  right: "|",
  bottomRight: "+",
  bottom: "=",
  bottomLeft: "+",
  left: "|",
} as const;

const ASCII_BOLD = {
  topLeft: "#",
  top: "=",
  topRight: "#",
  right: "#",
  bottomRight: "#",
  bottom: "=",
  bottomLeft: "#",
  left: "#",
} as const;

// borderStyle that honours FOREMAN_ASCII=1 (TUI spec §8.2). Returns Ink's
// built-in "single" / "double" key when Unicode borders are fine, or a
// concrete shape object built from ASCII glyphs when the env asks for it.
export function singleBorder(): "single" | typeof ASCII_SINGLE {
  return isAsciiMode() ? ASCII_SINGLE : "single";
}

export function doubleBorder(): "double" | typeof ASCII_DOUBLE {
  return isAsciiMode() ? ASCII_DOUBLE : "double";
}

/** Bold border for critical-severity surfaces (#234 UX-6). Falls back to
 *  "double" on unicode and a `#`-framed box in ASCII mode. */
export function boldBorder(): "bold" | typeof ASCII_BOLD {
  return isAsciiMode() ? ASCII_BOLD : "bold";
}

/** Pick the border style for a risk bucket (#234 UX-6). low/medium →
 *  single, high → double, critical → bold. Components that frame by severity
 *  call this instead of duplicating the switch. */
export function borderForRisk(
  bucket: RiskBucket,
): ReturnType<typeof singleBorder | typeof doubleBorder | typeof boldBorder> {
  switch (bucket) {
    case "critical":
      return boldBorder();
    case "high":
      return doubleBorder();
    case "medium":
    case "low":
    default:
      return singleBorder();
  }
}
