import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { detectInstall, type InstallSpec } from "./agent-install.js";

// =============================================================================
// Which copy of an agent runs, who installed it, and which model it uses
// =============================================================================
//
// The 2.3.0 real test had Codex installed by Homebrew's Node
// (/opt/homebrew/bin/codex → /opt/homebrew/lib/node_modules/@openai/codex)
// while `npm` on PATH was nvm's. Foreman asked nvm's npm for the version
// (none there), so it never saw that Codex was months old, and an update
// would have installed a second copy under nvm that the old one shadowed.
// So: follow the binary Foreman actually launches to the package that
// owns it, and update it with that installation's own npm.

/** Who installed the binary on PATH, so it can be updated the same way. */
export type AgentInstallOwner =
  | { kind: "npm"; prefix: string; npm: string | null }
  | { kind: "brew"; formula: string }
  | { kind: "other" };

export interface InstalledAgent {
  /** The binary on PATH (as found, before symlinks). */
  binPath: string;
  version: string | null;
  owner: AgentInstallOwner;
}

/** The copy of the agent that Foreman launches, or null when none is found. */
export function installedAgent(install: InstallSpec, env: NodeJS.ProcessEnv = process.env): InstalledAgent | null {
  const found = detectInstall(install, env);
  if (!found.found || !found.path) return null;
  return describeBinary(found.path, install.npm);
}

/** Follow `binPath` to the package that owns it. */
export function describeBinary(binPath: string, npmPackage: string | null): InstalledAgent {
  let real = binPath;
  try {
    real = realpathSync(binPath);
  } catch {
    // a dangling link: nothing to follow
  }
  if (npmPackage) {
    const marker = `${sep}node_modules${sep}${npmPackage.split("/").join(sep)}${sep}`;
    const at = real.indexOf(marker);
    if (at >= 0) {
      const pkgDir = real.slice(0, at + marker.length - 1);
      const modules = real.slice(0, at);
      // <prefix>/lib/node_modules (POSIX) or <prefix>/node_modules (Windows)
      const prefix = modules.endsWith(`${sep}lib`) ? dirname(modules) : modules;
      const npm = [join(prefix, "bin", "npm"), join(prefix, "npm.cmd"), join(prefix, "npm")].find((p) => existsSync(p)) ?? null;
      return { binPath, version: packageVersion(join(pkgDir, "package.json")), owner: { kind: "npm", prefix, npm } };
    }
  }
  const cellar = /[/\\]Cellar[/\\]([^/\\]+)[/\\]([^/\\]+)[/\\]/.exec(real);
  if (cellar) return { binPath, version: cellar[2] ?? null, owner: { kind: "brew", formula: cellar[1]! } };
  return { binPath, version: null, owner: { kind: "other" } };
}

function packageVersion(path: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** The command that updates this copy in place (argv), or null when
 *  Foreman can't tell how it was installed. */
export function updateCommandFor(agent: InstalledAgent, npmPackage: string | null): string[] | null {
  if (agent.owner.kind === "npm" && npmPackage) {
    return [agent.owner.npm ?? "npm", "install", "-g", `${npmPackage}@latest`];
  }
  if (agent.owner.kind === "brew") return ["brew", "upgrade", agent.owner.formula];
  return null;
}

/** The model the agent uses when Foreman doesn't pick one: its own
 *  config's `model`, or null when it leaves that to the agent. */
export function agentDefaultModel(runtime: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.HOME || homedir();
  try {
    if (runtime === "codex") {
      const file = join(env.CODEX_HOME || join(home, ".codex"), "config.toml");
      if (!existsSync(file)) return null;
      const model = (parseToml(readFileSync(file, "utf-8")) as { model?: unknown }).model;
      return typeof model === "string" && model.trim() ? model.trim() : null;
    }
    if (runtime === "claude-code") {
      const file = join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "settings.json");
      if (!existsSync(file)) return null;
      const model = (JSON.parse(readFileSync(file, "utf-8")) as { model?: unknown }).model;
      return typeof model === "string" && model.trim() ? model.trim() : null;
    }
  } catch {
    // an unreadable config: say we don't know
  }
  return null;
}
