import { spawn } from "node:child_process";
import type { DetectedOs } from "./machine-capability.js";

// =============================================================================
// Ollama installer (#367)
// =============================================================================
//
// Wizard offers to install Ollama when it's missing. Per-OS install path:
//   macOS:  brew install ollama && brew services start ollama
//   linux:  curl -fsSL https://ollama.com/install.sh | bash
//   win32:  manual — point at the download page
//
// Reuses the spawn pattern from agent-install.ts: stdio=ignore so Ollama's
// installer can't deadlock on a /dev/tty read, idle timeout so a stuck
// install eventually gets killed with an actionable message.

export interface OllamaInstallPlan {
  /** Command we'd run. Null when no automated path (Windows). */
  command: string | null;
  /** Human-readable description to show in the wizard. */
  description: string;
  /** Where the user should go if we can't install for them. */
  manualUrl: string | null;
}

export function planOllamaInstall(os: DetectedOs): OllamaInstallPlan {
  if (os === "darwin") {
    return {
      command: "brew install ollama && brew services start ollama",
      description: "Install via Homebrew, then start the background service.",
      manualUrl: "https://ollama.com/download",
    };
  }
  if (os === "linux") {
    return {
      command: "curl -fsSL https://ollama.com/install.sh | bash",
      description: "Install via the official installer script (systemd or launchd-style service).",
      manualUrl: "https://ollama.com/download",
    };
  }
  if (os === "win32") {
    return {
      command: null,
      description: "Windows install is a downloadable installer — Foreman can't run it automatically.",
      manualUrl: "https://ollama.com/download/windows",
    };
  }
  return {
    command: null,
    description: "No automated install path for this OS.",
    manualUrl: "https://ollama.com/download",
  };
}

export interface OllamaInstallResult {
  ok: boolean;
  exitCode: number;
  manualCommand: string;
}

export interface RunOllamaInstallOptions {
  plan: OllamaInstallPlan;
  onLine?: (line: string) => void;
  /** Test seam — replace the real spawn with a mock. */
  spawnImpl?: typeof spawn;
  /** Idle stdout/stderr inactivity timeout — kill if no output for this
   *  long. Default 90 seconds. */
  idleTimeoutMs?: number;
}

export async function runOllamaInstall(
  options: RunOllamaInstallOptions,
): Promise<OllamaInstallResult> {
  if (!options.plan.command) {
    return {
      ok: false,
      exitCode: -1,
      manualCommand: `(no automated install — visit ${
        options.plan.manualUrl ?? "https://ollama.com/download"
      })`,
    };
  }
  const command = options.plan.command;
  const spawnImpl = options.spawnImpl ?? spawn;
  const idle = options.idleTimeoutMs ?? 90_000;

  return new Promise<OllamaInstallResult>((resolveResult) => {
    const child = spawnImpl("bash", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    let lastOutputAt = Date.now();
    let killed = false;
    const watchdog = setInterval(() => {
      if (Date.now() - lastOutputAt > idle) {
        killed = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        clearInterval(watchdog);
      }
    }, 5_000);
    const onChunk = (chunk: Buffer): void => {
      lastOutputAt = Date.now();
      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) options.onLine?.(line);
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("error", () => {
      clearInterval(watchdog);
      resolveResult({ ok: false, exitCode: -1, manualCommand: command });
    });
    child.on("close", (code) => {
      clearInterval(watchdog);
      if (killed) {
        resolveResult({
          ok: false,
          exitCode: -1,
          manualCommand:
            `(install timed out with no output for ${
              Math.round(idle / 1000)
            }s — run manually: ${command})`,
        });
        return;
      }
      resolveResult({
        ok: code === 0,
        exitCode: code ?? -1,
        manualCommand: command,
      });
    });
  });
}
