// Runs before anything else is imported (first import in index.ts), so the
// colour libraries see it when they read the environment at load time.
//
// NO_COLOR (https://no-color.org) is honoured by Foreman's own CLI output,
// but chalk / supports-color (used by Ink for the TUI) only look at
// FORCE_COLOR. Translate one into the other unless the user set both.
if (process.env.NO_COLOR && process.env.FORCE_COLOR === undefined) {
  process.env.FORCE_COLOR = "0";
}

export {};
