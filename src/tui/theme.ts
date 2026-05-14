export const theme = {
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
  bg: {
    elevated: "#1E1E1E",
  },
  symbols: {
    bullet: "▸",
    check: "✓",
    cross: "✗",
    warn: "⚠",
    activeDot: "●",
    idleDot: "○",
    reason: "◆",
    timer: "⏱",
  },
} as const;

export type Theme = typeof theme;

export function isAsciiMode(): boolean {
  return process.env.FOREMAN_ASCII === "1";
}

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

// borderStyle that honours FOREMAN_ASCII=1 (TUI spec §8.2). Returns Ink's
// built-in "single" / "double" key when Unicode borders are fine, or a
// concrete shape object built from ASCII glyphs when the env asks for it.
export function singleBorder(): "single" | typeof ASCII_SINGLE {
  return isAsciiMode() ? ASCII_SINGLE : "single";
}

export function doubleBorder(): "double" | typeof ASCII_DOUBLE {
  return isAsciiMode() ? ASCII_DOUBLE : "double";
}
