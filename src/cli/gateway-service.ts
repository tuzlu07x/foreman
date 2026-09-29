import { ForemanAlreadyRunningError } from "../core/foreman-pidfile.js";
import { probeGateway } from "../core/gateway.js";
import { PolicyLoadError } from "../core/policy-load.js";
import { closeDb } from "../db/client.js";
import { getForemanPaths } from "../utils/config.js";
import { startForeman, type StartedForeman } from "./start.js";

// =============================================================================
// `foreman daemon --service`: the headless gateway
// =============================================================================
//
// What the background service (`foreman service install`) runs: everything
// `foreman start` runs except the TUI, so approvals reach Telegram, Slack
// and Discord (and taps come back) with no terminal open. One gateway per
// home: while `foreman start` (or another service) holds it, this one
// waits and takes over when that one stops. A `foreman start` opened while
// this runs attaches to it (TUI only).

/** How often a waiting service checks whether it can take over. */
const SERVICE_RETRY_MS = 3_000;

export interface GatewayServiceIo {
  /** A line for the service's log. */
  log: (message: string) => void;
  /** Stop for good (exit 0: the service manager must not restart it). */
  fail: (message: string) => never;
  /** Resolves on SIGTERM / SIGINT. */
  stopped: Promise<void>;
}

/** Run the headless gateway until a signal (or `/foreman stop`) ends it. */
export async function runGatewayService(io: GatewayServiceIo): Promise<void> {
  let stopping = false;
  void io.stopped.then(() => {
    stopping = true;
  });
  const { configDir } = getForemanPaths();
  let gateway: StartedForeman | null = null;
  let waiting = false;
  while (!gateway) {
    try {
      gateway = startForeman({ withTui: false, headless: { log: io.log } });
    } catch (err) {
      if (err instanceof PolicyLoadError) io.fail(`${err.message} (fix ${err.path})`);
      if (!(err instanceof ForemanAlreadyRunningError)) io.fail(err instanceof Error ? err.message : String(err));
      closeDb();
      if (!waiting) {
        const holder = probeGateway(configDir);
        const who =
          holder.state === "running" && holder.mode === "headless"
            ? `another Foreman gateway is running on this home (pid ${holder.pid})`
            : `foreman start is running on this home (pid ${(err as ForemanAlreadyRunningError).pid})`;
        io.log(`${who}; waiting to take over when it stops`);
      }
      waiting = true;
      await Promise.race([io.stopped, new Promise((resolve) => setTimeout(resolve, SERVICE_RETRY_MS))]);
      if (stopping) return;
    }
  }
  // `/foreman stop` (the control channel) ends it too.
  await Promise.race([gateway.waitForExit(), io.stopped]);
  io.log("stopping");
  await gateway.shutdown();
}
