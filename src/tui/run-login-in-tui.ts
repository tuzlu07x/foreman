import { spawnSync } from "node:child_process";
import { runOauthFlows, type OauthFlowResult } from "../cli/run-oauth-flow.js";
import type { WizardOauthRunStep } from "./setup-wizard.js";

// =============================================================================
// In-TUI login runner (#tui-login)
// =============================================================================

export interface SuspendableTui {
  clear: () => void;
}

export function runLoginWithSuspendedTui(
  steps: WizardOauthRunStep[],
  instance: SuspendableTui | null,
): OauthFlowResult[] {
  if (steps.length === 0) return [];

  const stdin = process.stdin;
  const isTty = Boolean(stdin.isTTY);
  const wasRaw = Boolean((stdin as { isRaw?: boolean }).isRaw);

  if (isTty && typeof stdin.setRawMode === "function") {
    stdin.setRawMode(false);
  }
  instance?.clear();

  try {
    return runOauthFlows(steps);
  } finally {
    pauseForEnter();
    instance?.clear();
    if (isTty && typeof stdin.setRawMode === "function" && wasRaw) {
      stdin.setRawMode(true);
    }
    stdin.resume();
  }
}

/**
 * Block until the user presses Enter, reading from the controlling terminal.
 * Runs in a child shell with inherited stdio so it works regardless of the
 * parent's stream state. No-ops harmlessly when there's no tty (piped input
 * makes `read` return immediately).
 */
function pauseForEnter(): void {
  spawnSync(
    "printf '\\n  Press Enter to return to Foreman… ' >&2 && read -r _ < /dev/tty",
    { shell: true, stdio: ["inherit", "inherit", "inherit"] },
  );
}
