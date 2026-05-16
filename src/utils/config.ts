import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Platform = "linux" | "darwin" | "win32";

export interface ForemanPaths {
  /**
   * Backward-compat alias. Equals `configDir` so existing callers that read
   * `paths.root` keep working. New code should pick the specific directory.
   */
  root: string;
  /** Config dir (policy, identity, secret key). */
  configDir: string;
  /** State dir (foreman.db). */
  stateDir: string;
  /** Cache dir (registry cache, future use). */
  cacheDir: string;
  /** Legacy `~/.foreman/` dir — only set when present on disk. */
  legacyHome: string | null;

  // Specific file paths (derived from the dirs above).
  policyPath: string;
  /** OOB notifications config (`<configDir>/notify.yaml`) — #235 / C11a. */
  notifyConfigPath: string;
  identityPath: string;
  /**
   * Canonical Foreman persona file (`<configDir>/SOUL.md`). Foreman writes its
   * contents into each registered agent's identity hook (e.g. `~/.hermes/SOUL.md`)
   * so the user-facing brand is "Foreman" instead of the partner runtime.
   */
  soulPath: string;
  secretsKeyPath: string;
  dbPath: string;

  /** Migration .sql directory shipped with the package. */
  migrationsPath: string;
}

export interface ResolveDirsOptions {
  /** When set, every dir collapses to this single path (test + legacy mode). */
  foremanHome?: string | null;
  platform?: Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export function legacyHome(homeDir: string = homedir()): string {
  return resolve(homeDir, ".foreman");
}

// Pure path resolver. Doesn't touch disk. Use this from tests with a mocked
// platform + env to assert per-OS behaviour.
export function resolveDirs(
  options: ResolveDirsOptions = {},
): Pick<ForemanPaths, "configDir" | "stateDir" | "cacheDir"> {
  const home = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const platform = options.platform ?? (process.platform as Platform);

  if (options.foremanHome) {
    return {
      configDir: options.foremanHome,
      stateDir: options.foremanHome,
      cacheDir: resolve(options.foremanHome, "cache"),
    };
  }

  if (platform === "darwin") {
    return {
      configDir: resolve(home, "Library", "Application Support", "foreman"),
      stateDir: resolve(home, "Library", "Application Support", "foreman"),
      cacheDir: resolve(home, "Library", "Caches", "foreman"),
    };
  }

  if (platform === "win32") {
    const appData = env.APPDATA ?? resolve(home, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA ?? resolve(home, "AppData", "Local");
    return {
      configDir: resolve(appData, "foreman"),
      stateDir: resolve(appData, "foreman"),
      cacheDir: resolve(localAppData, "foreman", "Cache"),
    };
  }

  // Linux + everything else: XDG.
  const xdgConfig = env.XDG_CONFIG_HOME ?? resolve(home, ".config");
  const xdgState = env.XDG_STATE_HOME ?? resolve(home, ".local", "state");
  const xdgCache = env.XDG_CACHE_HOME ?? resolve(home, ".cache");
  return {
    configDir: resolve(xdgConfig, "foreman"),
    stateDir: resolve(xdgState, "foreman"),
    cacheDir: resolve(xdgCache, "foreman"),
  };
}

export function getForemanPaths(): ForemanPaths {
  const env = process.env;
  const foremanHomeEnv = env.FOREMAN_HOME ?? null;
  const dirs = resolveDirs({ foremanHome: foremanHomeEnv });

  const home = homedir();
  const legacy = legacyHome(home);
  const legacyDetected = foremanHomeEnv === null && existsSync(legacy);

  return {
    root: dirs.configDir,
    configDir: dirs.configDir,
    stateDir: dirs.stateDir,
    cacheDir: dirs.cacheDir,
    legacyHome: legacyDetected ? legacy : null,
    policyPath: resolve(dirs.configDir, "policy.yaml"),
    notifyConfigPath: resolve(dirs.configDir, "notify.yaml"),
    identityPath: resolve(dirs.configDir, "identity.key"),
    soulPath: resolve(dirs.configDir, "SOUL.md"),
    secretsKeyPath: resolve(dirs.configDir, "secrets.key"),
    dbPath: resolve(dirs.stateDir, "foreman.db"),
    migrationsPath: resolveMigrationsDir(),
  };
}

/**
 * @deprecated Use `getForemanPaths().configDir` (or `.stateDir`, `.cacheDir`).
 * Kept for callers that still want the legacy single-dir abstraction.
 */
export function getForemanHome(): string {
  return getForemanPaths().configDir;
}

/**
 * Migrations are shipped as raw .sql files. They live at different paths
 * depending on how the code is being run:
 *   - bundled via tsup → dist/db/migrations relative to dist/cli/index.js
 *   - vitest / tsx running source → src/db/migrations relative to src/utils/config.ts
 *   - as a last resort, `<cwd>/src/db/migrations` for invocation from the repo root
 */
function resolveMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../db/migrations"),
    resolve(here, "../../src/db/migrations"),
    resolve(process.cwd(), "src/db/migrations"),
    resolve(process.cwd(), "dist/db/migrations"),
  ];
  for (const c of candidates) {
    if (existsSync(resolve(c, "meta", "_journal.json"))) return c;
  }
  throw new Error(
    `Could not locate a populated migrations directory (no meta/_journal.json). Tried: ${candidates.join(", ")}`,
  );
}
