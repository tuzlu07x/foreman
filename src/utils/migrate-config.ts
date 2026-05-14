import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { getForemanPaths, legacyHome, type ForemanPaths } from "./config.js";

export interface MigrationContext {
  /** Override the home dir used to find ~/.foreman/. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Override the resolved paths. Defaults to `getForemanPaths()`. */
  paths?: ForemanPaths;
}

export interface MigrationPlan {
  legacyRoot: string;
  configDir: string;
  stateDir: string;
  cacheDir: string;
  /** File moves grouped by destination dir. Computed but not yet executed. */
  moves: MigrationMove[];
  /** True when the new layout already has at least one of these files. */
  destinationHasData: boolean;
}

export interface MigrationMove {
  from: string;
  to: string;
  destDir: "config" | "state" | "cache";
}

export type MigrationStatus =
  | "no-legacy"
  | "ready"
  | "destination-has-data"
  | "done";

const CONFIG_FILES = ["policy.yaml", "identity.key", "secrets.key"];
const STATE_FILES = ["foreman.db"];
const CACHE_FILES = ["registry.json"];

export class LegacyConflictError extends Error {
  constructor(public readonly conflicts: string[]) {
    super(
      `Cannot migrate — the new layout already contains: ${conflicts.join(", ")}`,
    );
    this.name = "LegacyConflictError";
  }
}

// Plans the legacy → new layout move without touching disk.
export function planMigration(
  ctx: MigrationContext = {},
): MigrationPlan & { status: MigrationStatus } {
  const paths = ctx.paths ?? getForemanPaths();
  const home = ctx.homeDir ?? homedir();
  const legacyRoot = legacyHome(home);
  if (!existsSync(legacyRoot)) {
    return {
      status: "no-legacy",
      legacyRoot,
      configDir: paths.configDir,
      stateDir: paths.stateDir,
      cacheDir: paths.cacheDir,
      moves: [],
      destinationHasData: false,
    };
  }

  const moves: MigrationMove[] = [];
  for (const name of CONFIG_FILES) {
    const src = resolve(legacyRoot, name);
    if (existsSync(src)) {
      moves.push({
        from: src,
        to: resolve(paths.configDir, name),
        destDir: "config",
      });
    }
  }
  for (const name of STATE_FILES) {
    const src = resolve(legacyRoot, name);
    if (existsSync(src)) {
      moves.push({
        from: src,
        to: resolve(paths.stateDir, name),
        destDir: "state",
      });
    }
  }
  for (const name of CACHE_FILES) {
    const src = resolve(legacyRoot, "cache", name);
    if (existsSync(src)) {
      moves.push({
        from: src,
        to: resolve(paths.cacheDir, name),
        destDir: "cache",
      });
    }
  }

  const destinationHasData = moves.some((m) => existsSync(m.to));

  if (moves.length === 0) {
    return {
      status: "done",
      legacyRoot,
      configDir: paths.configDir,
      stateDir: paths.stateDir,
      cacheDir: paths.cacheDir,
      moves,
      destinationHasData,
    };
  }

  return {
    status: destinationHasData ? "destination-has-data" : "ready",
    legacyRoot,
    configDir: paths.configDir,
    stateDir: paths.stateDir,
    cacheDir: paths.cacheDir,
    moves,
    destinationHasData,
  };
}

// Executes the plan. Refuses to overwrite existing files in the new layout
// unless `force` is set. Skips moves whose source no longer exists (idempotent
// re-runs).
export function executeMigration(
  plan: MigrationPlan,
  options: { force?: boolean } = {},
): { movedCount: number; skippedCount: number } {
  if (!options.force) {
    const conflicts = plan.moves
      .filter((m) => existsSync(m.to))
      .map((m) => m.to);
    if (conflicts.length > 0) throw new LegacyConflictError(conflicts);
  }

  let movedCount = 0;
  let skippedCount = 0;
  for (const move of plan.moves) {
    if (!existsSync(move.from)) {
      skippedCount += 1;
      continue;
    }
    mkdirSync(dirname(move.to), { recursive: true });
    renameSync(move.from, move.to);
    movedCount += 1;
  }
  return { movedCount, skippedCount };
}

// True when ~/.foreman/ still has files we'd consider migrating. Used for
// the boot-time warning to avoid alarming users who've already migrated and
// only have an empty ~/.foreman/ shell.
export function legacyHasInterestingFiles(homeDir?: string): boolean {
  const home = homeDir ?? homedir();
  const root = legacyHome(home);
  if (!existsSync(root)) return false;
  try {
    if (statSync(root).isFile()) return false;
    for (const name of readdirSync(root)) {
      if (
        CONFIG_FILES.includes(name) ||
        STATE_FILES.includes(name) ||
        name === "cache"
      ) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}
