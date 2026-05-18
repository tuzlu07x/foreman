import { execFileSync } from "node:child_process";
import { delimiter } from "node:path";
import { existsSync } from "node:fs";

// =============================================================================
// Ollama detector (#367)
// =============================================================================
//
// "What's the Ollama state on this machine?" — single sync call returning
// installed/running/pulled-models. Used by the wizard before showing the
// model picker, by the doctor, and by the auto-installer's idempotent
// re-check.

export interface OllamaDetection {
  /** `ollama` binary on PATH. */
  installed: boolean;
  /** `ollama --version` output if installed, e.g. "ollama version is 0.4.6". */
  version: string | null;
  /** Path to the binary if installed. */
  binaryPath: string | null;
  /** `ollama list` succeeded → service is running + responsive. */
  serviceReachable: boolean;
  /** Model names already pulled (`ollama list` output, first column).
   *  Empty when service unreachable. */
  installedModels: string[];
}

export interface DetectOllamaOptions {
  /** Override $PATH for tests. */
  env?: NodeJS.ProcessEnv;
  /** Test seam — replace the real spawn with a mock that returns
   *  whatever the test wants. Args: (cmd, args). Should throw to
   *  simulate the binary missing / service not responding. */
  exec?: (cmd: string, args: readonly string[]) => string;
}

export function detectOllama(
  options: DetectOllamaOptions = {},
): OllamaDetection {
  const env = options.env ?? process.env;
  const exec = options.exec ?? defaultExec;
  const binaryPath = whichOnPath("ollama", env);
  if (binaryPath === null) {
    return {
      installed: false,
      version: null,
      binaryPath: null,
      serviceReachable: false,
      installedModels: [],
    };
  }
  let version: string | null = null;
  try {
    version = exec("ollama", ["--version"]).trim() || null;
  } catch {
    /* `ollama --version` rarely fails when binary exists — treat as unknown */
  }
  let serviceReachable = false;
  let installedModels: string[] = [];
  try {
    const listOut = exec("ollama", ["list"]);
    serviceReachable = true;
    installedModels = parseOllamaList(listOut);
  } catch {
    serviceReachable = false;
  }
  return {
    installed: true,
    version,
    binaryPath,
    serviceReachable,
    installedModels,
  };
}

function defaultExec(cmd: string, args: readonly string[]): string {
  return execFileSync(cmd, [...args], {
    encoding: "utf-8",
    timeout: 3000,
  });
}

function whichOnPath(bin: string, env: NodeJS.ProcessEnv): string | null {
  const pathVar = env.PATH ?? "";
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = `${dir}/${bin}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Parse `ollama list`'s tabular output:
 *
 *   NAME                ID              SIZE      MODIFIED
 *   llama3.2:3b         abc123          2.0 GB    2 hours ago
 *   qwen2.5:7b          def456          4.7 GB    1 day ago
 *
 * Returns just the NAME column. Whitespace-tolerant — Ollama formats this
 * for human eyes, not machines.
 */
export function parseOllamaList(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (/^NAME\b/i.test(trimmed)) continue;
    const name = trimmed.split(/\s+/)[0];
    if (!name) continue;
    out.push(name);
  }
  return out;
}
