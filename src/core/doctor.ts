import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter } from "node:path";
import { parse as parseYaml } from "yaml";
import { createInMemoryDb, getDb } from "../db/client.js";
import { getMigrationStatus } from "../db/migration-status.js";
import { derivePublicKey } from "../identity/keypair.js";
import { sign, verify } from "../identity/signing.js";
import { MCPGateway } from "../mcp/gateway.js";
import { getForemanPaths } from "../utils/config.js";
import { legacyHasInterestingFiles } from "../utils/migrate-config.js";
import { EventBus, type ForemanEventMap } from "./event-bus.js";
import { RegistryService } from "./registry.js";
import { getUpdateCachePath, isNewer } from "./update-check.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  remediation?: string;
}

export interface DoctorReport {
  checks: CheckResult[];
  /** 0 if all ok; 1 if any warn (but no fail); 2 if any fail. */
  exitCode: 0 | 1 | 2;
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
}

const MIN_NODE_MAJOR = 20;

export function checkPaths(): CheckResult {
  const paths = getForemanPaths();
  return {
    name: "paths",
    status: "ok",
    message: `config=${paths.configDir} · state=${paths.stateDir} · cache=${paths.cacheDir}`,
  };
}

export function checkLegacyHome(): CheckResult {
  if (!legacyHasInterestingFiles()) {
    return {
      name: "legacy_home",
      status: "ok",
      message: "no legacy ~/.foreman/ files detected",
    };
  }
  return {
    name: "legacy_home",
    status: "warn",
    message: "legacy ~/.foreman/ still contains config or state files",
    remediation:
      "Run 'foreman migrate-config' to move them into the platform-native dirs.",
  };
}

export function checkNodeVersion(): CheckResult {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    return {
      name: "node_version",
      status: "fail",
      message: `Node ${process.versions.node} is below the required ${MIN_NODE_MAJOR}.x`,
      remediation: `Install Node >= ${MIN_NODE_MAJOR} (e.g. via nvm: 'nvm install ${MIN_NODE_MAJOR}').`,
    };
  }
  return {
    name: "node_version",
    status: "ok",
    message: `Node ${process.versions.node}`,
  };
}

export function checkForemanHome(): CheckResult {
  const paths = getForemanPaths();
  if (!existsSync(paths.root)) {
    return {
      name: "foreman_home",
      status: "fail",
      message: `${paths.root} does not exist`,
      remediation: "Run 'foreman init' to create it.",
    };
  }
  try {
    accessSync(paths.root, constants.W_OK);
  } catch {
    return {
      name: "foreman_home",
      status: "fail",
      message: `${paths.root} is not writable`,
      remediation: `Check permissions: 'chmod u+w ${paths.root}'.`,
    };
  }
  return {
    name: "foreman_home",
    status: "ok",
    message: paths.root,
  };
}

export function checkExpectedFiles(): CheckResult {
  const paths = getForemanPaths();
  const missing: string[] = [];
  if (!existsSync(paths.identityPath)) missing.push("identity.key");
  if (!existsSync(paths.policyPath)) missing.push("policy.yaml");
  if (!existsSync(paths.dbPath)) missing.push("foreman.db");
  if (missing.length > 0) {
    return {
      name: "expected_files",
      status: "fail",
      message: `missing files in ${paths.root}: ${missing.join(", ")}`,
      remediation: "Run 'foreman init' to regenerate the missing files.",
    };
  }
  return {
    name: "expected_files",
    status: "ok",
    message: "identity.key, policy.yaml, foreman.db present",
  };
}

export function checkIdentityKey(): CheckResult {
  const paths = getForemanPaths();
  if (!existsSync(paths.identityPath)) {
    return {
      name: "identity_key",
      status: "fail",
      message: `${paths.identityPath} not found`,
      remediation: "Run 'foreman init'.",
    };
  }
  try {
    const privateKey = readFileSync(paths.identityPath);
    if (privateKey.length !== 32) {
      return {
        name: "identity_key",
        status: "fail",
        message: `identity.key is ${privateKey.length} bytes (expected 32)`,
        remediation:
          "Identity file is corrupt. Back it up, delete it, and re-run 'foreman init' (this rotates the key).",
      };
    }
    const publicKey = derivePublicKey(privateKey);
    const signature = sign("foreman-doctor-probe", privateKey);
    if (!verify("foreman-doctor-probe", signature, publicKey)) {
      return {
        name: "identity_key",
        status: "fail",
        message: "Ed25519 sign/verify round-trip failed",
        remediation:
          "Identity file is corrupt — back it up and re-run 'foreman init'.",
      };
    }
    return {
      name: "identity_key",
      status: "ok",
      message: `ed25519:${publicKey.subarray(0, 4).toString("hex")}…`,
    };
  } catch (err) {
    return {
      name: "identity_key",
      status: "fail",
      message: `failed to load identity.key: ${err instanceof Error ? err.message : String(err)}`,
      remediation: "Check the file's permissions or re-run 'foreman init'.",
    };
  }
}

export function checkDatabase(): CheckResult {
  const paths = getForemanPaths();
  if (!existsSync(paths.dbPath)) {
    return {
      name: "database",
      status: "fail",
      message: `${paths.dbPath} not found`,
      remediation: "Run 'foreman init'.",
    };
  }
  try {
    getDb();
    return {
      name: "database",
      status: "ok",
      message: `${paths.dbPath} opens; schema is at the latest migration`,
    };
  } catch (err) {
    return {
      name: "database",
      status: "fail",
      message: `database failed to open or migrate: ${err instanceof Error ? err.message : String(err)}`,
      remediation:
        "Back up foreman.db, then re-run 'foreman init'. If the schema is ahead of this binary, upgrade foreman-agent.",
    };
  }
}

export function checkFts5(): CheckResult {
  try {
    const { sqlite } = createInMemoryDb();
    const row = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='requests_fts'",
      )
      .get();
    sqlite.close();
    if (!row) {
      return {
        name: "fts5",
        status: "fail",
        message: "requests_fts virtual table not present after migration",
        remediation:
          "The linked sqlite was built without FTS5. Reinstall better-sqlite3 against a sqlite that includes FTS5: 'npm rebuild better-sqlite3'.",
      };
    }
    return {
      name: "fts5",
      status: "ok",
      message: "FTS5 available; requests_fts ready",
    };
  } catch (err) {
    return {
      name: "fts5",
      status: "fail",
      message: `FTS5 probe failed: ${err instanceof Error ? err.message : String(err)}`,
      remediation: "Reinstall better-sqlite3 with FTS5 enabled.",
    };
  }
}

export function checkPolicyYaml(): CheckResult {
  const paths = getForemanPaths();
  if (!existsSync(paths.policyPath)) {
    return {
      name: "policy_yaml",
      status: "fail",
      message: `${paths.policyPath} not found`,
      remediation: "Run 'foreman init' to write the default template.",
    };
  }
  try {
    const text = readFileSync(paths.policyPath, "utf-8");
    const parsed = parseYaml(text);
    if (
      parsed !== null &&
      (typeof parsed !== "object" || Array.isArray(parsed))
    ) {
      return {
        name: "policy_yaml",
        status: "fail",
        message: "policy.yaml top-level must be an object (or empty)",
        remediation:
          "Edit ~/.foreman/policy.yaml — see the comments in the template for shape.",
      };
    }
    return {
      name: "policy_yaml",
      status: "ok",
      message: "parses",
    };
  } catch (err) {
    return {
      name: "policy_yaml",
      status: "fail",
      message: `policy.yaml failed to parse: ${err instanceof Error ? err.message : String(err)}`,
      remediation:
        "Open ~/.foreman/policy.yaml and fix the syntax (YAML validators online help).",
    };
  }
}

export function checkAgentsRegistered(): CheckResult {
  const paths = getForemanPaths();
  if (!existsSync(paths.dbPath)) {
    return {
      name: "agents_registered",
      status: "fail",
      message: "database is missing, cannot count agents",
      remediation: "Run 'foreman init' first.",
    };
  }
  try {
    const db = getDb();
    const registry = new RegistryService(db, new EventBus<ForemanEventMap>());
    const count = registry.list().length;
    if (count === 0) {
      return {
        name: "agents_registered",
        status: "warn",
        message: "no agents registered yet",
        remediation:
          "Add one with 'foreman agent add' or 'foreman registry list' to pick from the curated catalog.",
      };
    }
    return {
      name: "agents_registered",
      status: "ok",
      message: `${count} registered`,
    };
  } catch (err) {
    return {
      name: "agents_registered",
      status: "fail",
      message: `could not read agents: ${err instanceof Error ? err.message : String(err)}`,
      remediation: "Run 'foreman init' if the database is fresh.",
    };
  }
}

export function checkMcpGateway(): CheckResult {
  try {
    const gateway = new MCPGateway(new EventBus<ForemanEventMap>());
    gateway.dispose();
    return {
      name: "mcp_gateway",
      status: "ok",
      message: "gateway instantiates cleanly (stdio transport ready)",
    };
  } catch (err) {
    return {
      name: "mcp_gateway",
      status: "fail",
      message: `MCP gateway failed to instantiate: ${err instanceof Error ? err.message : String(err)}`,
      remediation:
        "Likely a bad install. Try 'npm install -g foreman-agent' again or run from the source tree.",
    };
  }
}

const APP_VERSION = "0.1.0";

export function checkUpdate(): CheckResult {
  if (process.env.FOREMAN_NO_UPDATE_CHECK === "1") {
    return {
      name: "update",
      status: "ok",
      message: "skipped (FOREMAN_NO_UPDATE_CHECK=1)",
    };
  }
  const path = getUpdateCachePath();
  if (!existsSync(path)) {
    return {
      name: "update",
      status: "ok",
      message: "no cached check yet — 'foreman start' will refresh on next run",
    };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as {
      latest?: unknown;
      observedAt?: unknown;
    };
    if (typeof raw.latest !== "string") {
      return {
        name: "update",
        status: "ok",
        message: "cache present but unreadable — will refresh on next start",
      };
    }
    if (isNewer(raw.latest, APP_VERSION)) {
      return {
        name: "update",
        status: "warn",
        message: `installed ${APP_VERSION}, latest ${raw.latest}`,
        remediation:
          "npm install -g foreman-agent@latest  (or 'brew upgrade foreman' if you tapped it)",
      };
    }
    return {
      name: "update",
      status: "ok",
      message: `up to date (latest ${raw.latest})`,
    };
  } catch {
    return {
      name: "update",
      status: "ok",
      message: "cache unreadable — will refresh on next start",
    };
  }
}

export function checkMigrations(): CheckResult {
  const paths = getForemanPaths();
  if (!existsSync(paths.dbPath)) {
    return {
      name: "migrations",
      status: "ok",
      message: "no DB yet — schema lands on 'foreman init'",
    };
  }
  try {
    const status = getMigrationStatus(paths.dbPath, paths.migrationsPath);
    if (status.pendingCount === 0) {
      return {
        name: "migrations",
        status: "ok",
        message: `up to date (${status.appliedCount} applied)`,
      };
    }
    return {
      name: "migrations",
      status: "warn",
      message: `${status.pendingCount} pending: ${status.pendingTags.join(", ")}`,
      remediation:
        "Run 'foreman migrate --apply' — it backs up to foreman.db.bak first.",
    };
  } catch (err) {
    return {
      name: "migrations",
      status: "fail",
      message: `could not read migration status: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function checkChafa(env: NodeJS.ProcessEnv = process.env): CheckResult {
  if (whichOnPath("chafa", env)) {
    return {
      name: "chafa",
      status: "ok",
      message: "chafa on PATH (premium boot mascot will render)",
    };
  }
  try {
    execFileSync("chafa", ["--version"], { stdio: "ignore", timeout: 1000 });
    return {
      name: "chafa",
      status: "ok",
      message: "chafa available",
    };
  } catch {
    return {
      name: "chafa",
      status: "warn",
      message: "chafa not found",
      remediation:
        "Optional: 'brew install chafa' (macOS) or 'apt install chafa' (Debian/Ubuntu) for the higher-fidelity boot mascot.",
    };
  }
}

const CHECKS: (() => CheckResult)[] = [
  checkNodeVersion,
  checkPaths,
  checkForemanHome,
  checkExpectedFiles,
  checkIdentityKey,
  checkDatabase,
  checkMigrations,
  checkFts5,
  checkPolicyYaml,
  checkAgentsRegistered,
  checkMcpGateway,
  checkLegacyHome,
  checkUpdate,
  () => checkChafa(),
];

export function runDoctor(_options: DoctorOptions = {}): DoctorReport {
  const checks: CheckResult[] = [];
  for (const fn of CHECKS) {
    try {
      checks.push(fn());
    } catch (err) {
      checks.push({
        name: "doctor",
        status: "fail",
        message: `check threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  const exitCode = computeExitCode(checks);
  return { checks, exitCode };
}

export function computeExitCode(checks: CheckResult[]): 0 | 1 | 2 {
  if (checks.some((c) => c.status === "fail")) return 2;
  if (checks.some((c) => c.status === "warn")) return 1;
  return 0;
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
