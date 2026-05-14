import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getForemanPaths } from "../utils/config.js";

const REGISTRY_VERSION = 1;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_UPSTREAM_URL =
  "https://raw.githubusercontent.com/tuzlu07x/foreman/main/registry/agents.json";

export const AgentEntrySchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/, "id must be lowercase kebab-case"),
    name: z.string().min(1),
    tagline: z.string().min(1).max(80),
    homepage: z.string().url(),
    install: z
      .object({
        npm: z.string().nullable(),
        brew: z.string().nullable(),
        /** URL of a `curl | bash` style installer (Hermes, OpenClaw). */
        script: z.string().url().nullable().optional(),
        /** Override the binary name when it differs from the npm package basename. */
        binary: z.string().nullable().optional(),
      })
      .strict(),
    config_paths: z.array(z.string()),
    config_snippet: z.string().nullable().optional(),
    /** Override the top-level key for the MCP server block in this agent's
     * config. Defaults to `mcpServers` (Claude Code / Hermes / OpenClaw).
     * Codex uses `mcp_servers` (snake_case). */
    mcp_servers_key: z.string().nullable().optional(),
    required_secrets: z.array(z.string()),
    optional_secrets: z.array(z.string()),
    mcp_compatible: z.boolean(),
    supported_versions: z.string().min(1),
    min_foreman_version: z.string().min(1),
  })
  .strict();

export const RegistryDocSchema = z
  .object({
    version: z.literal(REGISTRY_VERSION),
    agents: z.array(AgentEntrySchema),
  })
  .strict();

export type AgentEntry = z.infer<typeof AgentEntrySchema>;
export type RegistryDoc = z.infer<typeof RegistryDocSchema>;

export class RegistryNotFoundError extends Error {
  constructor() {
    super(
      "Bundled registry/agents.json was not found. Re-install the foreman-agent package or run from a checked-out repo.",
    );
    this.name = "RegistryNotFoundError";
  }
}

export class AgentNotInRegistryError extends Error {
  constructor(public readonly agentId: string) {
    super(`No agent with id "${agentId}" in the registry`);
    this.name = "AgentNotInRegistryError";
  }
}

export class RegistryValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: { path: string; message: string }[],
  ) {
    super(message);
    this.name = "RegistryValidationError";
  }
}

// Resolves the bundled registry/agents.json that ships with the package.
// Looks in dev (src) and bundled (dist) layouts plus the current working dir.
export function resolveBundledRegistryPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "..", "registry", "agents.json"),
    resolve(here, "..", "..", "registry", "agents.json"),
    resolve(here, "..", "registry", "agents.json"),
    resolve(process.cwd(), "registry", "agents.json"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export function getRegistryCachePath(): string {
  return resolve(getForemanPaths().cacheDir, "registry.json");
}

export function getUpstreamRegistryUrl(): string {
  return process.env.FOREMAN_REGISTRY_URL ?? DEFAULT_UPSTREAM_URL;
}

export function parseRegistryText(text: string): RegistryDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new RegistryValidationError(
      `registry/agents.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      [],
    );
  }
  const parsed = RegistryDocSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RegistryValidationError(
      "registry/agents.json failed schema validation",
      parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    );
  }
  return parsed.data;
}

export function loadBundledRegistry(): RegistryDoc {
  const path = resolveBundledRegistryPath();
  if (!path) throw new RegistryNotFoundError();
  return parseRegistryText(readFileSync(path, "utf-8"));
}

// Picks the cached copy if present and within TTL, otherwise the bundled one.
// The cache is populated by `foreman registry update`.
export function loadActiveRegistry(now: number = Date.now()): {
  doc: RegistryDoc;
  source: "cache" | "bundled";
  cachedAt?: number;
} {
  const cachePath = getRegistryCachePath();
  if (existsSync(cachePath)) {
    try {
      const raw = JSON.parse(readFileSync(cachePath, "utf-8")) as {
        cachedAt?: number;
        doc?: unknown;
      };
      const cachedAt = typeof raw.cachedAt === "number" ? raw.cachedAt : 0;
      if (now - cachedAt < CACHE_TTL_MS && raw.doc) {
        const parsed = RegistryDocSchema.safeParse(raw.doc);
        if (parsed.success) {
          return { doc: parsed.data, source: "cache", cachedAt };
        }
      }
    } catch {
      /* fall through to bundled */
    }
  }
  return { doc: loadBundledRegistry(), source: "bundled" };
}

export function writeRegistryCache(
  doc: RegistryDoc,
  cachedAt: number = Date.now(),
): void {
  const cachePath = getRegistryCachePath();
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ cachedAt, doc }, null, 2), "utf-8");
}

export function findAgent(doc: RegistryDoc, agentId: string): AgentEntry {
  const entry = doc.agents.find((a) => a.id === agentId);
  if (!entry) throw new AgentNotInRegistryError(agentId);
  return entry;
}

export const REGISTRY_CACHE_TTL_MS = CACHE_TTL_MS;
