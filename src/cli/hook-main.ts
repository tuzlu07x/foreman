import {
  blockHook,
  fastHookArgs,
  hookTimeoutMs,
  hookViaDaemon,
  readHookStdin,
} from "./hook-client.js";

// Lightweight entry point for the PreToolUse hook (`foreman-hook <agent>`).
// Claude Code spawns the hook before every matching tool call, so start-up
// time is paid on each one. With `foreman start` running, this file only
// reads the payload and asks the daemon (#616), which already has the
// mediation stack loaded. Without one, it loads that stack (hook-inproc.js,
// a separate bundle: no Ink / React TUI, no LLM providers) and decides
// here, as before.
//
// Fail closed: anything that escapes below blocks the call (exit 2).
process.on("uncaughtException", (err) => blockHook(`internal error (${err.message}) — blocking the call`));
process.on("unhandledRejection", (err) =>
  blockHook(`internal error (${err instanceof Error ? err.message : String(err)}) — blocking the call`),
);

const argv = process.argv.slice(2);
const fast = fastHookArgs(argv);
if (fast) {
  const timeoutMs = hookTimeoutMs(fast.timeoutFlag);
  let raw: string;
  try {
    raw = await readHookStdin();
  } catch (err) {
    blockHook(
      `could not read the PreToolUse payload (${err instanceof Error ? err.message : String(err)}) — blocking the call.`,
    );
  }
  const viaDaemon = await hookViaDaemon(fast.agentId, timeoutMs, raw);
  if (viaDaemon !== null) process.exit(viaDaemon);
  const { runHook } = await import("./hook-inproc.js");
  process.exit(await runHook(fast.agentId, timeoutMs, raw));
} else {
  // Help, a usage error or an unusual flag: the full command answers it
  // (and blocks on anything it can't parse).
  const { hookCommand } = await import("./hook-inproc.js");
  await hookCommand.parseAsync(argv, { from: "user" });
}
