/**
 * Tiny ANSI helper for the scaffold CLI. The full theme lives with the
 * Ink TUI (#17). This only exists so init / start can emit a couple of
 * coloured lines without pulling in chalk.
 */
const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR

function wrap(open: string, close: string) {
  return (text: string): string =>
    supportsColor ? `\x1b[${open}m${text}\x1b[${close}m` : text
}

/** Foreman brand orange (#FF8C42), falling back to plain on non-TTY/NO_COLOR. */
export const orange = wrap('38;2;255;140;66', '0')
export const green = wrap('38;2;0;208;132', '0')
export const red = wrap('38;2;255;82;82', '0')
export const dim = wrap('2', '22')
export const bold = wrap('1', '22')
