import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// =============================================================================
// Cross-platform browser opener (#408 / #413 — Phase 5)
// =============================================================================
//
// Used by the wizard's required-setup step (and `foreman provider switch`
// remediation hints) to open a key-acquisition URL in the user's default
// browser. Best-effort: returns ok=false with a reason on failure so the
// caller can fall back to "paste this URL manually" UX.
//
// Platform dispatch:
//   - darwin → `open <url>`
//   - linux  → `xdg-open <url>` with `gnome-open` fallback
//   - win32  → `start "" <url>` (cmd.exe)
//   - else   → return ok=false (we don't pretend to know the platform)

export interface BrowserOpenResult {
  ok: boolean;
  /** When ok=false, free-text reason — surfaced to the user. */
  reason?: string;
  /** Which platform handler we picked, for diagnostic logging. */
  handler?: "darwin" | "linux-xdg" | "linux-gnome" | "win32" | "none";
}

export interface BrowserOpenOptions {
  /** Override the runtime's platform detection — used by tests. */
  platformOverride?: "darwin" | "linux" | "win32";
  /** Inject a custom exec runner — used by tests to assert which
   *  command would be run without actually opening a browser. */
  execImpl?: (
    cmd: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Open a URL in the user's default browser. Validates the input is a
 * legitimate http(s) URL before shelling out — defense against accidental
 * shell injection if the URL came from registry data.
 */
export async function openInBrowser(
  url: string,
  options: BrowserOpenOptions = {},
): Promise<BrowserOpenResult> {
  // Validate — only http(s) URLs go to the browser. Anything else is
  // rejected up front to avoid `file://` / `javascript:` / shell-escape
  // attempts via a malformed registry value.
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        ok: false,
        reason: `unsupported URL protocol: ${parsed.protocol}`,
        handler: "none",
      };
    }
  } catch {
    return { ok: false, reason: `invalid URL: ${url}`, handler: "none" };
  }

  const exec =
    options.execImpl ??
    (async (cmd: string, args: string[]) => {
      const { stdout, stderr } = await execFileAsync(cmd, args);
      return { stdout, stderr };
    });
  const plat = options.platformOverride ?? platform();

  if (plat === "darwin") {
    try {
      await exec("open", [url]);
      return { ok: true, handler: "darwin" };
    } catch (err) {
      return {
        ok: false,
        reason: errMessage(err),
        handler: "darwin",
      };
    }
  }
  if (plat === "linux") {
    // Try xdg-open first, fall back to gnome-open. If neither is on PATH,
    // return ok=false so the caller can show the URL for manual copy.
    try {
      await exec("xdg-open", [url]);
      return { ok: true, handler: "linux-xdg" };
    } catch (xdgErr) {
      try {
        await exec("gnome-open", [url]);
        return { ok: true, handler: "linux-gnome" };
      } catch (gnomeErr) {
        return {
          ok: false,
          reason: `xdg-open + gnome-open both failed (${errMessage(xdgErr)})`,
          handler: "linux-xdg",
        };
      }
    }
  }
  if (plat === "win32") {
    try {
      // `start` is a cmd.exe builtin — we wrap it via `cmd /c`.
      // The empty "" is the title arg (start treats first quoted arg as
      // the window title); without it `start "https://..."` treats the
      // URL as the title and never opens anything.
      await exec("cmd", ["/c", "start", "", url]);
      return { ok: true, handler: "win32" };
    } catch (err) {
      return { ok: false, reason: errMessage(err), handler: "win32" };
    }
  }
  return {
    ok: false,
    reason: `no browser-open handler for platform: ${plat}`,
    handler: "none",
  };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
