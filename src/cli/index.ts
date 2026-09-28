import "./env-preflight.js";
import { buildProgram } from "./program.js";

const program = buildProgram();

function isForemanFriendlyError(
  err: unknown,
): err is Error & { foremanFriendly: true } {
  return (
    err instanceof Error &&
    (err as Error & { foremanFriendly?: boolean }).foremanFriendly === true
  );
}

process.on("uncaughtException", (err) => {
  if (isForemanFriendlyError(err)) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
});

// parseAsync: most command actions are async; parse() would not await
// them, so their rejections escaped as unhandled promises.
await program.parseAsync();
