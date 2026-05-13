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
