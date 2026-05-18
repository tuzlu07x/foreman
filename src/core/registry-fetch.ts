import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  getRegistryCachePath,
  getUpstreamRegistryUrl,
  parseRegistryText,
  type RegistryDoc,
} from "./registry-catalog.js";
import { verifyRegistrySignature } from "./registry-sign.js";
import { getForemanPaths } from "../utils/config.js";

// =============================================================================
// Signed remote registry fetch (#421)
// =============================================================================
//
// `foreman registry update` flow:
//   1. Fetch `<url>` and `<url>.sig` (if signature verification enabled)
//   2. Verify Ed25519 signature with the user's pinned public key
//   3. Schema-validate the parsed JSON (`parseRegistryText`)
//   4. Refuse if `version` field exceeds the Foreman build's REGISTRY_VERSION
//   5. Back up existing cache to `<cache>.bak`
//   6. Atomic install via tmp file + rename
//
// `foreman registry rollback` flow:
//   1. Restore `<cache>.bak` to `<cache>` (atomic rename)
//   2. Delete `.bak` (one-deep rollback — earlier history is in source control)

export interface FetchResult {
  ok: boolean;
  /** Free-text describing what happened. */
  message: string;
  /** Parsed registry doc when ok=true. */
  doc?: RegistryDoc;
  /** Was an existing cache backed up? */
  backedUp?: boolean;
  /** What URL did we hit? */
  sourceUrl?: string;
  /** Was the signature actually verified (vs. skipped with --insecure-no-verify)? */
  signatureVerified?: boolean;
}

export interface FetchOptions {
  /** URL of the registry JSON. Defaults to `getUpstreamRegistryUrl()`. */
  url?: string;
  /** Skip signature verification — required when no public key is
   *  configured AND the user passed --insecure-no-verify. Defaults to
   *  false; without an explicit opt-in, a missing public key is an error. */
  allowInsecure?: boolean;
  /** Override the configured public key path — used by tests. */
  publicKeyPath?: string;
  /** Inject the HTTP fetcher — used by tests. Receives a URL, must
   *  return either bytes or a typed error. */
  fetchImpl?: (
    url: string,
  ) => Promise<{ ok: boolean; status: number; body: Buffer; statusText?: string }>;
  /** Override the cache path — used by tests. */
  cachePath?: string;
  /** Cap for a single fetch (ms). Default 15s. */
  timeoutMs?: number;
}

const SIG_SUFFIX = ".sig";

export async function fetchAndInstallRegistry(
  opts: FetchOptions = {},
): Promise<FetchResult> {
  const url = opts.url ?? getUpstreamRegistryUrl();
  const cachePath = opts.cachePath ?? getRegistryCachePath();
  const fetchImpl = opts.fetchImpl ?? defaultFetch(opts.timeoutMs ?? 15_000);
  const publicKeyPath =
    opts.publicKeyPath ??
    resolve(getForemanPaths().configDir, "registry-pubkey.hex");

  // 1) Fetch the JSON body.
  const body = await fetchImpl(url);
  if (!body.ok) {
    return {
      ok: false,
      message: `failed to fetch ${url}: HTTP ${body.status}${
        body.statusText ? ` ${body.statusText}` : ""
      }`,
      sourceUrl: url,
    };
  }

  // 2) Verify signature (if not opted out).
  let signatureVerified = false;
  if (opts.allowInsecure) {
    // Explicit opt-out — skip both fetching .sig and verifying.
    signatureVerified = false;
  } else {
    if (!existsSync(publicKeyPath)) {
      return {
        ok: false,
        message:
          `no registry public key configured at ${publicKeyPath}. ` +
          `Configure one (32-byte hex Ed25519 key) or re-run with --insecure-no-verify ` +
          `to skip signature checks (NOT recommended for production).`,
        sourceUrl: url,
      };
    }
    const publicKeyHex = readFileSync(publicKeyPath, "utf-8").trim();
    const sigRes = await fetchImpl(url + SIG_SUFFIX);
    if (!sigRes.ok) {
      return {
        ok: false,
        message: `failed to fetch signature from ${url}${SIG_SUFFIX}: HTTP ${sigRes.status}`,
        sourceUrl: url,
      };
    }
    const verify = verifyRegistrySignature({
      body: body.body,
      signatureHex: sigRes.body.toString("utf-8").trim(),
      publicKeyHex,
    });
    if (!verify.ok) {
      return {
        ok: false,
        message: `signature verification failed: ${verify.reason ?? "unknown"}`,
        sourceUrl: url,
      };
    }
    signatureVerified = true;
  }

  // 3) Schema-validate the JSON. Throws RegistryValidationError on failure.
  let doc: RegistryDoc;
  try {
    doc = parseRegistryText(body.body.toString("utf-8"), url);
  } catch (err) {
    return {
      ok: false,
      message: `registry parse failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      sourceUrl: url,
    };
  }

  // 4) Back up + atomic install.
  let backedUp = false;
  if (existsSync(cachePath)) {
    const backupPath = cachePath + ".bak";
    try {
      copyFileSync(cachePath, backupPath);
      backedUp = true;
    } catch (err) {
      return {
        ok: false,
        message: `failed to back up existing cache to ${backupPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        sourceUrl: url,
      };
    }
  }
  try {
    atomicWriteJson(cachePath, doc);
  } catch (err) {
    return {
      ok: false,
      message: `failed to write new cache: ${
        err instanceof Error ? err.message : String(err)
      }`,
      sourceUrl: url,
      backedUp,
    };
  }

  return {
    ok: true,
    message: `registry updated from ${url}`,
    doc,
    backedUp,
    sourceUrl: url,
    signatureVerified,
  };
}

// =============================================================================
// Rollback
// =============================================================================

export interface RollbackResult {
  ok: boolean;
  message: string;
}

export function rollbackRegistry(cachePath?: string): RollbackResult {
  const path = cachePath ?? getRegistryCachePath();
  const backupPath = path + ".bak";
  if (!existsSync(backupPath)) {
    return {
      ok: false,
      message: `no backup at ${backupPath} — nothing to roll back to`,
    };
  }
  try {
    renameSync(backupPath, path);
    return { ok: true, message: `restored registry from ${backupPath}` };
  } catch (err) {
    return {
      ok: false,
      message: `rollback failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

// =============================================================================
// Status
// =============================================================================

export interface RegistryStatus {
  /** URL the next `update` will fetch from. */
  sourceUrl: string;
  /** Path on disk where the cache lives. */
  cachePath: string;
  /** True when a cached registry exists. */
  cached: boolean;
  /** Last-modified time of the cache file (ms epoch). */
  cachedAt: number | null;
  /** Cache file size in bytes. */
  sizeBytes: number | null;
  /** True when a rollback target exists. */
  hasBackup: boolean;
  /** True when a registry public key is configured. */
  hasPublicKey: boolean;
  /** Path of the configured public key file. */
  publicKeyPath: string;
  /** Schema version of the cached doc, if loadable. */
  version: number | null;
  /** Agent count in the cached doc, if loadable. */
  agentCount: number | null;
}

export function getRegistryStatus(): RegistryStatus {
  const cachePath = getRegistryCachePath();
  const publicKeyPath = resolve(
    getForemanPaths().configDir,
    "registry-pubkey.hex",
  );
  const status: RegistryStatus = {
    sourceUrl: getUpstreamRegistryUrl(),
    cachePath,
    cached: existsSync(cachePath),
    cachedAt: null,
    sizeBytes: null,
    hasBackup: existsSync(cachePath + ".bak"),
    hasPublicKey: existsSync(publicKeyPath),
    publicKeyPath,
    version: null,
    agentCount: null,
  };
  if (status.cached) {
    try {
      const stats = statSync(cachePath);
      status.cachedAt = stats.mtimeMs;
      status.sizeBytes = stats.size;
      const doc = JSON.parse(readFileSync(cachePath, "utf-8"));
      if (doc && typeof doc === "object") {
        if (typeof doc.version === "number") status.version = doc.version;
        if (Array.isArray(doc.agents)) status.agentCount = doc.agents.length;
      }
    } catch {
      /* best-effort — cache exists but unreadable, leave fields null */
    }
  }
  return status;
}

// =============================================================================
// Internals
// =============================================================================

function atomicWriteJson(path: string, doc: RegistryDoc): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

function defaultFetch(
  timeoutMs: number,
): (url: string) => Promise<{
  ok: boolean;
  status: number;
  body: Buffer;
  statusText?: string;
}> {
  return async (url: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      const bodyBuf = Buffer.from(await res.arrayBuffer());
      return {
        ok: res.ok,
        status: res.status,
        body: bodyBuf,
        statusText: res.statusText,
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        body: Buffer.alloc(0),
        statusText: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

// Re-export for tests that want to delete a backup without re-importing fs.
export function deleteRegistryBackup(cachePath?: string): boolean {
  const path = (cachePath ?? getRegistryCachePath()) + ".bak";
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
