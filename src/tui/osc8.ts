// OSC 8 hyperlink escape sequence. Modern terminals (iTerm2, Kitty,
// Wezterm, Ghostty, recent Terminal.app) render the embedded text as a
// clickable link; non-supporting terminals fall back to printing the raw
// label which is still readable. Used by the wizard's [o] open hotkey
// for service walkthroughs (#175 — BotFather, GitHub tokens page, etc).

const ESC = "\x1B";

export function osc8(url: string, label: string = url): string {
  return `${ESC}]8;;${url}${ESC}\\${label}${ESC}]8;;${ESC}\\`;
}
