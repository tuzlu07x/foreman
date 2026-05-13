import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type ConfigFormat = "yaml" | "json";

export interface InjectionPlan {
  alreadyHasForeman: boolean;
  before: string;
  after: string;
  format: ConfigFormat;
}

export class UnsupportedConfigFormatError extends Error {
  constructor(public readonly path: string) {
    super(
      `Cannot inject MCP snippet into ${path} — only .yaml/.yml/.json are supported`,
    );
    this.name = "UnsupportedConfigFormatError";
  }
}

export function detectConfigFormat(path: string): ConfigFormat {
  const ext = extname(path).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  if (ext === ".json") return "json";
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
  const alreadyHasForeman = hasForemanServer(existing);
  if (alreadyHasForeman) {
    return { alreadyHasForeman: true, before, after: before, format };
  }
  const merged = mergeSnippet(existing, snippet);
  const after =
    format === "yaml"
      ? stringifyYaml(merged)
      : `${JSON.stringify(merged, null, 2)}\n`;
  return { alreadyHasForeman, before, after, format };
}

export function applyInjection(configPath: string, plan: InjectionPlan): void {
  if (plan.alreadyHasForeman) return;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, plan.after, "utf-8");
}

function parseDoc(text: string, format: ConfigFormat): Record<string, unknown> {
  const raw =
    format === "yaml"
      ? (parseYaml(text) as unknown)
      : (JSON.parse(text) as unknown);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return raw as Record<string, unknown>;
}

function hasForemanServer(doc: Record<string, unknown>): boolean {
  const mcpServers = doc.mcpServers;
  if (
    mcpServers &&
    typeof mcpServers === "object" &&
    !Array.isArray(mcpServers) &&
    "foreman" in (mcpServers as Record<string, unknown>)
  ) {
    return true;
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
      return true;
    }
  }
  return false;
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
