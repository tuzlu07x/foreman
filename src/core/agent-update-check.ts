import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getForemanPaths } from "../utils/config.js";
import {
  findAgent,
  type AgentEntry,
  type RegistryDoc,
} from "./registry-catalog.js";
import type { RegisteredAgent } from "./registry.js";
import { isNewer } from "./update-check.js";

const NPM_REGISTRY_URL =
  process.env.FOREMAN_NPM_REGISTRY ?? "https://registry.npmjs.org";
const DEFAULT_TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface AgentUpdateStatus {
  agentId: string;
  registryId: string;
  displayName: string;
  npmPackage: string;
  current: string | null;
  latest: string | null;
  supportedRange: string;
  hasUpdate: boolean;
  isOvershoot: boolean;
  source: "cache" | "network" | null;
  observedAt: number;
  error?:
    | "no-registry-entry"
    | "no-npm-pkg"
    | "install-version-unknown"
    | "network-error";
}

export interface AgentUpdateCheckOptions {
  cacheDir?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  cacheTtlMs?: number;
  registryUrl?: string;
  resolveInstalledVersion?: (pkg: string) => string | null;
  ignoreSkipEnv?: boolean;
}

export function getAgentVersionCacheDir(): string {
  return resolve(getForemanPaths().cacheDir, "agent-versions");
}

export function getAgentVersionCachePath(
  agentId: string,
  cacheDir: string = getAgentVersionCacheDir(),
): string {
  return resolve(cacheDir, `${agentId}.json`);
}

export async function checkAgentUpdates(
  agents: ReadonlyArray<
    Pick<RegisteredAgent, "id" | "displayName" | "metadata">
  >,
  registry: RegistryDoc,
  options: AgentUpdateCheckOptions = {},
): Promise<AgentUpdateStatus[]> {
  if (
    !options.ignoreSkipEnv &&
    process.env.FOREMAN_NO_AGENT_UPDATE_CHECK === "1"
  ) {
    return [];
  }
  return Promise.all(
    agents.map((agent) => checkSingleAgent(agent, registry, options)),
  );
}

async function checkSingleAgent(
  agent: Pick<RegisteredAgent, "id" | "displayName" | "metadata">,
  registry: RegistryDoc,
  options: AgentUpdateCheckOptions,
): Promise<AgentUpdateStatus> {
  const registryId =
    typeof agent.metadata?.registryId === "string"
      ? agent.metadata.registryId
      : null;
  const base: AgentUpdateStatus = {
    agentId: agent.id,
    registryId: registryId ?? "",
    displayName: agent.displayName,
    npmPackage: "",
    current: null,
    latest: null,
    supportedRange: "",
    hasUpdate: false,
    isOvershoot: false,
    source: null,
    observedAt: Date.now(),
  };

  if (!registryId) return { ...base, error: "no-registry-entry" };
  let entry: AgentEntry;
  try {
    entry = findAgent(registry, registryId);
  } catch {
    return { ...base, registryId, error: "no-registry-entry" };
  }
  base.registryId = entry.id;
  base.supportedRange = entry.supported_versions;
  if (!entry.install.npm) return { ...base, error: "no-npm-pkg" };
  base.npmPackage = entry.install.npm;

  const resolveVersion =
    options.resolveInstalledVersion ?? getInstalledNpmVersion;
  const current = resolveVersion(entry.install.npm);
  base.current = current;

  const cached = readCache(agent.id, options);
  if (cached) {
    return finalize(base, current, cached.latest, "cache", cached.observedAt);
  }

  const latest = await fetchLatestNpmVersion(entry.install.npm, options).catch(
    () => null,
  );
  if (latest === null) {
    return { ...base, error: "network-error" };
  }
  const observedAt = Date.now();
  writeCache(agent.id, { latest, observedAt }, options);
  return finalize(base, current, latest, "network", observedAt);
}

function finalize(
  base: AgentUpdateStatus,
  current: string | null,
  latest: string,
  source: "cache" | "network",
  observedAt: number,
): AgentUpdateStatus {
  if (current === null) {
    return {
      ...base,
      latest,
      source,
      observedAt,
      error: "install-version-unknown",
    };
  }
  return {
    ...base,
    current,
    latest,
    source,
    observedAt,
    hasUpdate: isNewer(latest, current),
    isOvershoot: isOvershoot(current, base.supportedRange),
  };
}

interface CacheBody {
  latest: string;
  observedAt: number;
}

function readCache(
  agentId: string,
  options: AgentUpdateCheckOptions,
): CacheBody | null {
  const cacheDir = options.cacheDir ?? getAgentVersionCacheDir();
  const path = getAgentVersionCachePath(agentId, cacheDir);
  const ttl = options.cacheTtlMs ?? CACHE_TTL_MS;
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
    /* stale / malformed — ignore */
  }
  return null;
}

function writeCache(
  agentId: string,
  body: CacheBody,
  options: AgentUpdateCheckOptions,
): void {
  const cacheDir = options.cacheDir ?? getAgentVersionCacheDir();
  const path = getAgentVersionCachePath(agentId, cacheDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(body), "utf-8");
  } catch {
    /* best-effort */
  }
}

async function fetchLatestNpmVersion(
  pkg: string,
  options: AgentUpdateCheckOptions,
): Promise<string> {
  const base = options.registryUrl ?? NPM_REGISTRY_URL;
  const url = `${base}/${encodeURIComponent(pkg).replace(/^%40/, "@")}/latest`;
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

// Reads <npmPrefix>/lib/node_modules/<pkg>/package.json and returns its version.
// Falls back to <prefix>/<pkg>/package.json for the Windows layout.
export function getInstalledNpmVersion(
  pkg: string,
  options: { npmPrefix?: string | null } = {},
): string | null {
  const prefix = options.npmPrefix ?? readNpmPrefix();
  if (!prefix) return null;
  const candidates = [
    resolve(prefix, "lib", "node_modules", pkg, "package.json"),
    resolve(prefix, "node_modules", pkg, "package.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const json = JSON.parse(readFileSync(path, "utf-8")) as {
        version?: unknown;
      };
      if (typeof json.version === "string") return json.version;
    } catch {
      /* malformed package.json — keep trying */
    }
  }
  return null;
}

function readNpmPrefix(): string | null {
  try {
    return execFileSync("npm", ["prefix", "-g"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// Extracts the exclusive upper bound from a supported_versions string. Handles
// the two shapes we ship in `registry/agents.json` today: ">=X.Y.Z" (no upper
// bound) and ">=X.Y.Z, <A.B.C" (exclusive upper). Anything else → null.
export function parseSupportedRangeUpperBound(range: string): string | null {
  const m = /<\s*(\d+\.\d+\.\d+)/.exec(range);
  return m && m[1] ? m[1] : null;
}

// `installed` >= the range's exclusive upper bound? That's an overshoot —
// the agent is newer than what we've tested against.
export function isOvershoot(installed: string | null, range: string): boolean {
  if (!installed) return false;
  const upper = parseSupportedRangeUpperBound(range);
  if (!upper) return false;
  return installed === upper || isNewer(installed, upper);
}
