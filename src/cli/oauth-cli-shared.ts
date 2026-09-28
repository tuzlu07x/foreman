import { mcpOAuthLockPath } from "../core/mcp-hub/boot.js";
import {
  DEFAULT_LOGIN_TIMEOUT_MS,
  MAX_LOGIN_TIMEOUT_MS,
  runMcpOAuthLogin,
} from "../core/mcp-hub/oauth-login.js";
import {
  removeMcpOAuthSession,
  revokeMcpOAuthTokens,
  storeMcpOAuthLogin,
} from "../core/mcp-hub/oauth-session.js";
import { describeMcpOAuthStatus, mcpOAuthStatus } from "../core/mcp-hub/oauth-store.js";
import type { SecretStore } from "../core/secret-store.js";
import { openInBrowser } from "../utils/browser-open.js";
import { bold, dim, green } from "./colors.js";
import { isHeadlessEnvironment } from "./run-oauth-flow.js";

// The browser sign-in and sign-out shared by `foreman mcp login / logout`
// and `foreman integrations login / logout`.

export { DEFAULT_LOGIN_TIMEOUT_MS, MAX_LOGIN_TIMEOUT_MS };

export interface CliLoginOptions {
  scope?: string;
  /** Try to open a browser (still skipped on a headless box). */
  browser: boolean;
  timeoutSeconds: number;
}

/** Parse `--timeout <seconds>`; throws on anything but a positive number. */
export function loginTimeoutSeconds(raw: string): number {
  const requested = Number(raw);
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error("--timeout must be a positive number of seconds");
  }
  return Math.min(requested, MAX_LOGIN_TIMEOUT_MS / 1000);
}

/** Run the MCP authorization flow for `name` and store the tokens. */
export async function cliOAuthLogin(
  paths: { mcpPinsPath: string },
  store: SecretStore,
  name: string,
  serverUrl: string,
  opts: CliLoginOptions,
): Promise<void> {
  const autoOpen = opts.browser && !isHeadlessEnvironment();
  const record = await runMcpOAuthLogin({
    server: name,
    serverUrl,
    ...(opts.scope ? { scope: opts.scope } : {}),
    timeoutMs: Math.round(opts.timeoutSeconds * 1000),
    presentAuthUrl: async (url) => {
      console.log(`Open this URL in your browser to sign in to ${bold(name)}:`);
      console.log("");
      console.log(`  ${url}`);
      console.log("");
      if (autoOpen) {
        const opened = await openInBrowser(url);
        if (!opened.ok) console.log(dim(`(could not open a browser: ${opened.reason ?? "unknown"})`));
      }
      console.log(dim(`Waiting for the sign-in to redirect back to this machine (up to ${opts.timeoutSeconds}s)…`));
    },
  });
  await storeMcpOAuthLogin(store, record, mcpOAuthLockPath(paths, name));
  const status = mcpOAuthStatus(store, name, serverUrl);
  console.log(`${green("✓")} ${name}: ${describeMcpOAuthStatus(name, status)}`);
  console.log(dim("Tokens are stored encrypted; only the hub attaches them upstream — agents never see them."));
}

/** Delete the stored session and revoke it at the provider when it can.
 *  Returns whether there was a session. */
export async function cliOAuthLogout(
  paths: { mcpPinsPath: string },
  store: SecretStore,
  name: string,
): Promise<boolean> {
  const removed = await removeMcpOAuthSession(store, name, mcpOAuthLockPath(paths, name));
  if (!removed.removed) {
    console.log(dim(`${name}: not logged in`));
    return false;
  }
  console.log(`${green("✓")} logged out of ${bold(name)} (local tokens deleted)`);
  if (removed.record) {
    const revocation = await revokeMcpOAuthTokens(removed.record);
    console.log(dim(revocation.revoked ? `  ${revocation.detail}` : `  not revoked at the provider: ${revocation.detail}`));
  }
  return true;
}
