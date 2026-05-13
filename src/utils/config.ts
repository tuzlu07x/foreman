import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ForemanPaths {
  /** Root config dir, e.g. ~/.foreman/ (overridable via FOREMAN_HOME). */
  root: string;
  /** SQLite database file. */
  dbPath: string;
  /** YAML policy file the user can edit. */
  policyPath: string;
  /** Ed25519 master identity (0600). */
  identityPath: string;
  /** Migration .sql directory shipped with the package. */
  migrationsPath: string;
}

export function getForemanHome(): string {
  return process.env.FOREMAN_HOME ?? resolve(homedir(), ".foreman");
}

export function getForemanPaths(): ForemanPaths {
  const root = getForemanHome();
  return {
    root,
    dbPath: resolve(root, "foreman.db"),
    policyPath: resolve(root, "policy.yaml"),
    identityPath: resolve(root, "identity.key"),
    migrationsPath: resolveMigrationsDir(),
  };
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
