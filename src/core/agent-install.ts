import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter } from "node:path";

export interface InstallSpec {
  npm: string | null;
  brew: string | null;
}

export interface InstallDetection {
  found: boolean;
  path?: string;
  source?: "PATH" | "npm-global";
}

// Synchronously detects whether the agent is already on the system. We deliberately
// keep this dependency-free: just walk PATH for the binary name (npm package basename),
// then fall back to checking npm's global prefix.
export function detectInstall(
  install: InstallSpec,
  env: NodeJS.ProcessEnv = process.env,
): InstallDetection {
  const binCandidates = candidateBinaries(install);
  if (binCandidates.length === 0) return { found: false };

  for (const bin of binCandidates) {
    const onPath = whichOnPath(bin, env);
    if (onPath) return { found: true, path: onPath, source: "PATH" };
  }

  if (install.npm) {
    const npmPrefix = readNpmPrefix();
    if (npmPrefix) {
      for (const bin of binCandidates) {
        const candidate = `${npmPrefix}/bin/${bin}`;
        if (existsSync(candidate)) {
          return { found: true, path: candidate, source: "npm-global" };
        }
      }
    }
  }

  return { found: false };
}

export interface InstallResult {
  ok: boolean;
  exitCode: number;
  manualCommand: string;
}

export interface RunInstallOptions {
  install: InstallSpec;
  onLine?: (line: string) => void;
}

// Streams the install command, line by line, to the caller. Returns the exit
// code + a copy-pasteable manual command for the failure case.
export async function runInstall(
  options: RunInstallOptions,
): Promise<InstallResult> {
  const command = preferredInstallCommand(options.install);
  if (!command) {
    return {
      ok: false,
      exitCode: -1,
      manualCommand: "(no install command in registry entry)",
    };
  }
  return new Promise<InstallResult>((resolveResult) => {
    const [cmd, ...args] = command.split(" ");
    const child = spawn(cmd!, args, { stdio: ["ignore", "pipe", "pipe"] });
    const onChunk = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) options.onLine?.(line);
      }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.on("error", () => {
      resolveResult({
        ok: false,
        exitCode: -1,
        manualCommand: command,
      });
    });
    child.on("close", (code) => {
      resolveResult({
        ok: code === 0,
        exitCode: code ?? -1,
        manualCommand: command,
      });
    });
  });
}

export function preferredInstallCommand(install: InstallSpec): string | null {
  if (install.npm) return `npm install -g ${install.npm}`;
  if (install.brew) return `brew install ${install.brew}`;
  return null;
}

function candidateBinaries(install: InstallSpec): string[] {
  const out: string[] = [];
  if (install.npm) out.push(binaryFromNpmPackage(install.npm));
  if (install.brew) out.push(binaryFromBrewFormula(install.brew));
  return Array.from(new Set(out));
}

function binaryFromNpmPackage(pkg: string): string {
  // Strip a scope prefix (`@scope/pkg` → `pkg`).
  const withoutScope = pkg.startsWith("@") ? (pkg.split("/")[1] ?? pkg) : pkg;
  return withoutScope;
}

function binaryFromBrewFormula(formula: string): string {
  // Strip a tap prefix (`org/tap/formula` → `formula`).
  const parts = formula.split("/");
  return parts[parts.length - 1] ?? formula;
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

function readNpmPrefix(): string | null {
  try {
    return execFileSync("npm", ["prefix", "-g"], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
  } catch {
    return null;
  }
}
