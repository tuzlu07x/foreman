import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getForemanPaths } from "../utils/config.js";

const NPM_REGISTRY_URL =
  process.env.FOREMAN_NPM_REGISTRY ?? "https://registry.npmjs.org";
const PACKAGE_NAME = "foreman-agent";
const DEFAULT_TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface UpdateCheckResult {
  /** Currently-installed version, as passed in. */
  current: string;
  /** Latest version from the registry (or the cache). */
  latest: string;
  /** True when `latest` strictly newer than `current`. */
  hasUpdate: boolean;
  /** Where the answer came from. */
  source: "cache" | "network";
  /** Epoch ms when the answer was first observed. */
  observedAt: number;
}

export interface UpdateCheckOptions {
  /** Override the cache file path (tests). */
  cachePath?: string;
  /** Provide a `fetch`-like to inject responses (tests). */
  fetchFn?: typeof fetch;
  /** Override the timeout (tests / slow networks). */
  timeoutMs?: number;
  /** Override the cache TTL (tests). */
  cacheTtlMs?: number;
  /** Override the registry URL (tests). */
  registryUrl?: string;
}

export function getUpdateCachePath(): string {
  return resolve(getForemanPaths().cacheDir, "version-check.json");
}

// fire-and-forget startup check. Never throws — network errors are
// swallowed and the function returns null in every failure mode.
export async function checkForUpdate(
  currentVersion: string,
  options: UpdateCheckOptions = {},
): Promise<UpdateCheckResult | null> {
  if (process.env.FOREMAN_NO_UPDATE_CHECK === "1") return null;

  const cachePath = options.cachePath ?? getUpdateCachePath();
  const ttl = options.cacheTtlMs ?? CACHE_TTL_MS;
  const cached = readCache(cachePath, ttl);
  if (cached) {
    return {
      current: currentVersion,
      latest: cached.latest,
      hasUpdate: isNewer(cached.latest, currentVersion),
      source: "cache",
      observedAt: cached.observedAt,
    };
  }

  const latest = await fetchLatest(options).catch(() => null);
  if (latest === null) return null;
  const observedAt = Date.now();
  writeCache(cachePath, { latest, observedAt });
  return {
    current: currentVersion,
    latest,
    hasUpdate: isNewer(latest, currentVersion),
    source: "network",
    observedAt,
  };
}

interface CacheBody {
  latest: string;
  observedAt: number;
}

function readCache(path: string, ttl: number): CacheBody | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<CacheBody>;
    if (
      typeof raw.latest === "string" &&
      typeof raw.observedAt === "number" &&
      Date.now() - raw.observedAt < ttl
    ) {
      return raw as CacheBody;
    }
  } catch {
    /* stale or malformed — ignore */
  }
  return null;
}

function writeCache(path: string, body: CacheBody): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(body), "utf-8");
  } catch {
    /* not critical — best-effort */
  }
}

async function fetchLatest(options: UpdateCheckOptions): Promise<string> {
  const url = `${options.registryUrl ?? NPM_REGISTRY_URL}/${PACKAGE_NAME}/latest`;
  const fetcher = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
    const body = (await res.json()) as { version?: string };
    if (typeof body.version !== "string") {
      throw new Error("registry response missing `version`");
    }
    return body.version;
  } finally {
    clearTimeout(timer);
  }
}

// Strict-newer semver compare. Accepts `MAJOR.MINOR.PATCH` plus an optional
// `-<pre>` suffix. Returns true iff `candidate` outranks `baseline`.
// `1.2.3-pre` < `1.2.3`; any malformed input yields false (fail closed).
export function isNewer(candidate: string, baseline: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(baseline);
  if (!a || !b) return false;
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  if (a.patch !== b.patch) return a.patch > b.patch;
  // Same MAJOR.MINOR.PATCH: a stable build outranks any pre-release; two
  // pre-releases compare lexicographically (best-effort, good enough for v0.1).
  if (a.pre === b.pre) return false;
  if (!a.pre && b.pre) return true;
  if (a.pre && !b.pre) return false;
  return (a.pre ?? "") > (b.pre ?? "");
}

interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

function parseSemver(s: string): SemverParts | null {
  const m =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      s.trim(),
    );
  if (!m) return null;
  const major = Number.parseInt(m[1] ?? "0", 10);
  const minor = Number.parseInt(m[2] ?? "0", 10);
  const patch = Number.parseInt(m[3] ?? "0", 10);
  return { major, minor, patch, pre: m[4] ?? null };
}
