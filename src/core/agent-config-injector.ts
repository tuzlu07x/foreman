import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export type ConfigFormat = "yaml" | "json" | "toml";

export interface InjectionPlan {
  alreadyHasForeman: boolean;
  /** True when the existing `foreman` entry differed from the canonical
   * snippet and was rewritten in `after`. UI uses this to log
   * "replaced stale entry" instead of "wrote new entry". */
  replacedStale: boolean;
  before: string;
  after: string;
  format: ConfigFormat;
}

export class UnsupportedConfigFormatError extends Error {
  constructor(public readonly path: string) {
    super(
      `Cannot inject MCP snippet into ${path} — only .yaml/.yml/.json/.toml are supported`,
    );
    this.name = "UnsupportedConfigFormatError";
  }
}

export function detectConfigFormat(path: string): ConfigFormat {
  const ext = extname(path).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  if (ext === ".json") return "json";
  if (ext === ".toml") return "toml";
  throw new UnsupportedConfigFormatError(path);
}

// Planning is pure: read what's on disk + show the proposed merge without
// touching anything yet. The wizard previews this; `applyInjection` commits.
export function planInjection(
  configPath: string,
  snippet: Record<string, unknown>,
): InjectionPlan {
  const format = detectConfigFormat(configPath);
  const before = existsSync(configPath)
    ? readFileSync(configPath, "utf-8")
    : "";
  const existing = before.length === 0 ? {} : parseDoc(before, format);
  const existingForeman = findForemanServer(existing);
  const canonicalForeman = findForemanServer(snippet);
  if (existingForeman && canonicalForeman) {
    if (deepEqual(existingForeman, canonicalForeman)) {
      return {
        alreadyHasForeman: true,
        replacedStale: false,
        before,
        after: before,
        format,
      };
    }
    // Existing entry is stale (different command/args). Replace it in place
    // and rewrite the file so the user's MCP wiring actually works.
    const rewritten = replaceForemanServer(existing, canonicalForeman);
    const after = serialize(rewritten, format);
    return {
      alreadyHasForeman: false,
      replacedStale: true,
      before,
      after,
      format,
    };
  }
  const merged = mergeSnippet(existing, snippet);
  const after = serialize(merged, format);
  return { alreadyHasForeman: false, replacedStale: false, before, after, format };
}

function serialize(doc: Record<string, unknown>, format: ConfigFormat): string {
  if (format === "yaml") return stringifyYaml(doc);
  if (format === "toml") return stringifyToml(doc) + "\n";
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function applyInjection(configPath: string, plan: InjectionPlan): void {
  if (plan.alreadyHasForeman && !plan.replacedStale) return;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, plan.after, "utf-8");
}

function parseDoc(text: string, format: ConfigFormat): Record<string, unknown> {
  const raw =
    format === "yaml"
      ? (parseYaml(text) as unknown)
      : format === "toml"
        ? (parseToml(text) as unknown)
        : (JSON.parse(text) as unknown);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return raw as Record<string, unknown>;
}

// Find the `foreman` MCP-server entry in any of the three documented
// conventions. Returns the entry value (typically { command, args }) or null
// when no entry is present. Used both for canonical-vs-stale comparison and
// for in-place replacement.
function findForemanServer(doc: Record<string, unknown>): unknown | null {
  //   mcpServers.foreman    (Claude Code / Hermes / OpenClaw style)
  //   mcp_servers.foreman   (Codex / TOML style)
  //   mcp.servers.foreman   (older nested pattern)
  for (const key of ["mcpServers", "mcp_servers"]) {
    const node = doc[key];
    if (
      node &&
      typeof node === "object" &&
      !Array.isArray(node) &&
      "foreman" in (node as Record<string, unknown>)
    ) {
      return (node as Record<string, unknown>).foreman;
    }
  }
  const mcp = doc.mcp;
  if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
    const servers = (mcp as Record<string, unknown>).servers;
    if (
      servers &&
      typeof servers === "object" &&
      !Array.isArray(servers) &&
      "foreman" in (servers as Record<string, unknown>)
    ) {
      return (servers as Record<string, unknown>).foreman;
    }
  }
  return null;
}

// Replace the existing `foreman` entry under whichever convention it lives,
// leaving every other key untouched. Returns a shallow copy.
function replaceForemanServer(
  doc: Record<string, unknown>,
  canonical: unknown,
): Record<string, unknown> {
  const out = { ...doc };
  for (const key of ["mcpServers", "mcp_servers"]) {
    const node = out[key];
    if (
      node &&
      typeof node === "object" &&
      !Array.isArray(node) &&
      "foreman" in (node as Record<string, unknown>)
    ) {
      out[key] = { ...(node as Record<string, unknown>), foreman: canonical };
      return out;
    }
  }
  const mcp = out.mcp;
  if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
    const servers = (mcp as Record<string, unknown>).servers;
    if (
      servers &&
      typeof servers === "object" &&
      !Array.isArray(servers) &&
      "foreman" in (servers as Record<string, unknown>)
    ) {
      out.mcp = {
        ...(mcp as Record<string, unknown>),
        servers: {
          ...(servers as Record<string, unknown>),
          foreman: canonical,
        },
      };
      return out;
    }
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual(ao[k], bo[k]));
}

function mergeSnippet(
  existing: Record<string, unknown>,
  snippet: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...existing };
  for (const [topKey, topValue] of Object.entries(snippet)) {
    const current = merged[topKey];
    if (
      current &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      topValue &&
      typeof topValue === "object" &&
      !Array.isArray(topValue)
    ) {
      merged[topKey] = deepMerge(
        current as Record<string, unknown>,
        topValue as Record<string, unknown>,
      );
    } else {
      merged[topKey] = topValue;
    }
  }
  return merged;
}

function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    if (
      cur &&
      typeof cur === "object" &&
      !Array.isArray(cur) &&
      v &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      out[k] = deepMerge(
        cur as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}
