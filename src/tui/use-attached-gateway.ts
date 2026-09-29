import { useEffect, useState } from "react";

const CHECK_MS = 5_000;

/**
 * For a TUI attached to the background gateway: "attached" while that
 * gateway runs, "stopped" once it is gone (approvals then reach no chat
 * channel until the service starts it again). Undefined when this TUI runs
 * the gateway itself.
 */
export function useAttachedGateway(
  probe: (() => { pid: number } | null) | undefined,
): "attached" | "stopped" | undefined {
  const [state, setState] = useState<"attached" | "stopped" | undefined>(() =>
    probe ? (safe(probe) ? "attached" : "stopped") : undefined,
  );
  useEffect(() => {
    if (!probe) return;
    const timer = setInterval(() => setState(safe(probe) ? "attached" : "stopped"), CHECK_MS);
    return () => clearInterval(timer);
  }, [probe]);
  return state;
}

function safe(probe: () => { pid: number } | null): boolean {
  try {
    return probe() !== null;
  } catch {
    return false;
  }
}
