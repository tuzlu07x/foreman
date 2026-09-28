// The hook's in-process path as its own bundle (dist/cli/hook-inproc.js):
// `foreman-hook` loads it only when no daemon answers (#616), so a call
// through the daemon never pays for the mediation stack's start-up.
export { hookCommand, runHook } from "./hook-cli.js";
