import { hookCommand } from "./hook-cli.js";

// Lightweight entry point for the PreToolUse hook (`foreman-hook <agent>`).
// Claude Code spawns the hook before every matching tool call, so start-up
// time is paid on each one. This bundle carries only the mediation stack —
// no Ink / React TUI, no LLM providers — and starts roughly a third faster
// than the full `foreman hook` CLI, which remains supported.
await hookCommand.parseAsync(process.argv.slice(2), { from: "user" });
