import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { AGENT_TOKEN_ENV } from "./agent-token.js";

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
  const target = FOREMAN_LOCATIONS.find((p) => getAt(snippet, p) !== undefined);
  if (target) {
    const canonical = getAt(snippet, target);
    const current = getAt(existing, target);
    // A `foreman` entry under another MCP key is one an older Foreman put
    // where this agent doesn't read it (#591). It goes, so the file holds
    // one wiring, and it's the live one.
    const strays = FOREMAN_LOCATIONS.filter((p) => p !== target && getAt(existing, p) !== undefined);
    if (current !== undefined && deepEqual(current, canonical) && strays.length === 0) {
      return { alreadyHasForeman: true, replacedStale: false, before, after: before, format };
    }
    let next = current !== undefined ? setAt(existing, target, canonical) : mergeSnippet(existing, snippet);
    for (const stray of strays) next = removeAt(next, stray);
    return {
      alreadyHasForeman: false,
      replacedStale: current !== undefined || strays.length > 0,
      before,
      after: serialize(next, format),
      format,
    };
  }
  const merged = mergeSnippet(existing, snippet);
  const after = serialize(merged, format);
  return { alreadyHasForeman: false, replacedStale: false, before, after, format };
}

export interface ZeroclawInjectionPlan extends InjectionPlan {
  /** `[agents.<alias>]` entries whose `mcp_bundles` list the foreman
   *  bundle. Empty means no agent connects to Foreman yet. */
  grantedAgents: string[];
}

/**
 * ZeroClaw keeps MCP servers in a `[[mcp.servers]]` array (by `name`) and
 * only connects an agent to the servers of the bundles in its
 * `agents.<alias>.mcp_bundles`. So: upsert the `foreman` server, define the
 * bundle, and grant it to every agent alias the file declares. A
 * `mcpServers` table an older Foreman wrote is removed: ZeroClaw reads that
 * key as an alias of `mcp` and ignores (or rejects) the entry.
 */
export function planZeroclawInjection(
  configPath: string,
  snippet: Record<string, unknown>,
): ZeroclawInjectionPlan {
  const format = detectConfigFormat(configPath);
  const before = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
  const existing = before.length === 0 ? {} : parseDoc(before, format);
  const server = getAt(snippet, ["mcp", "servers"]);
  const bundles = getAt(snippet, ["mcp_bundles"]);
  if (!Array.isArray(server) || !isPlainObject(server[0]) || !isPlainObject(bundles)) {
    throw new Error("not a ZeroClaw MCP snippet");
  }
  const foreman = server[0];
  const [bundleName, bundle] = Object.entries(bundles)[0] ?? [];
  if (!bundleName || !isPlainObject(bundle)) throw new Error("not a ZeroClaw MCP snippet");

  let next = removeAt(existing, ["mcpServers", "foreman"]);
  const servers = getAt(next, ["mcp", "servers"]);
  const list = Array.isArray(servers) ? servers : [];
  const at = list.findIndex((s) => isPlainObject(s) && s.name === foreman.name);
  const nextServers = at === -1 ? [...list, foreman] : list.map((s, i) => (i === at ? foreman : s));
  next = setAt(next, ["mcp", "servers"], nextServers);

  const currentBundle = getAt(next, ["mcp_bundles", bundleName]);
  const bundleServers = isPlainObject(currentBundle) && Array.isArray(currentBundle.servers) ? currentBundle.servers : [];
  next = setAt(next, ["mcp_bundles", bundleName], {
    ...(isPlainObject(currentBundle) ? currentBundle : {}),
    servers: bundleServers.includes(foreman.name) ? bundleServers : [...bundleServers, foreman.name],
  });

  const grantedAgents: string[] = [];
  const agents = getAt(next, ["agents"]);
  if (isPlainObject(agents)) {
    for (const [alias, agent] of Object.entries(agents)) {
      if (!isPlainObject(agent)) continue;
      const granted = Array.isArray(agent.mcp_bundles) ? agent.mcp_bundles : [];
      if (!granted.includes(bundleName)) next = setAt(next, ["agents", alias, "mcp_bundles"], [...granted, bundleName]);
      grantedAgents.push(alias);
    }
  }

  const unchanged = deepEqual(existing, next);
  const hadForeman =
    getAt(existing, ["mcpServers", "foreman"]) !== undefined ||
    (Array.isArray(servers) && servers.some((s) => isPlainObject(s) && s.name === foreman.name));
  return {
    alreadyHasForeman: unchanged,
    replacedStale: !unchanged && hadForeman,
    before,
    after: unchanged ? before : serialize(next, format),
    format,
    grantedAgents,
  };
}

function serialize(doc: Record<string, unknown>, format: ConfigFormat): string {
  if (format === "yaml") return stringifyYaml(doc);
  if (format === "toml") return stringifyToml(doc) + "\n";
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// The foreman entry carries the agent's identity token (#618), so the file
// is made owner-only before the token lands in it.
export function applyInjection(configPath: string, plan: InjectionPlan): void {
  if (plan.alreadyHasForeman && !plan.replacedStale) return;
  writeConfigAtomically(configPath, plan.after);
}

const CONFIG_MODE = 0o600;

/** Replace the file in one step (temp file + rename), so the agent never
 *  reads a half-written config — Claude Code rewrites ~/.claude.json
 *  itself. A symlinked dotfile is written through, not replaced. */
export function writeConfigAtomically(configPath: string, text: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const target = existsSync(configPath) ? realpathSync(configPath) : configPath;
  const tmp = `${target}.foreman-${process.pid}-${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, text, { encoding: "utf-8", mode: CONFIG_MODE, flag: "wx" });
    chmodSync(tmp, CONFIG_MODE);
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** The agent token the file's foreman entry passes: `undefined` when the
 *  file has no foreman entry (or can't be read), `null` when the entry
 *  carries no token. `snippet` (the agent's canonical wiring) says where
 *  the entry belongs; without it, any known location counts. Lets `doctor`
 *  spot wiring that lost its token or still carries a rotated one. */
export function readWiredAgentToken(
  configPath: string,
  snippet?: Record<string, unknown>,
): string | null | undefined {
  if (!existsSync(configPath)) return undefined;
  let doc: Record<string, unknown>;
  try {
    doc = parseDoc(readFileSync(configPath, "utf-8"), detectConfigFormat(configPath));
  } catch {
    return undefined;
  }
  const where = snippet ? FOREMAN_LOCATIONS.filter((p) => getAt(snippet, p) !== undefined) : FOREMAN_LOCATIONS;
  const inArray = getAt(doc, ["mcp", "servers"]);
  const found =
    where.map((p) => getAt(doc, p)).find((e) => e !== undefined) ??
    // ZeroClaw: `[[mcp.servers]]` entries are named.
    (Array.isArray(inArray) ? inArray.find((s) => isPlainObject(s) && s.name === "foreman") : undefined);
  if (!isPlainObject(found)) return undefined;
  const env = found.env;
  if (!isPlainObject(env)) return null;
  const token = env[AGENT_TOKEN_ENV];
  return typeof token === "string" && token.length > 0 ? token : null;
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

// Where agents keep a `foreman` MCP server entry:
//   mcpServers.foreman    (Claude Code ~/.claude.json, OpenClaw flat)
//   mcp_servers.foreman   (Codex TOML, Hermes YAML)
//   mcp.servers.foreman   (OpenClaw nested)
const FOREMAN_LOCATIONS: ReadonlyArray<readonly string[]> = [
  ["mcpServers", "foreman"],
  ["mcp_servers", "foreman"],
  ["mcp", "servers", "foreman"],
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getAt(doc: unknown, path: readonly string[]): unknown {
  let node: unknown = doc;
  for (const key of path) {
    if (!isPlainObject(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/** Copy of `doc` with `path` set to `value`, every other key (and its
 *  order) kept. */
function setAt(doc: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown> {
  const [key, ...rest] = path;
  if (key === undefined) return doc;
  const child = doc[key];
  return {
    ...doc,
    [key]: rest.length === 0 ? value : setAt(isPlainObject(child) ? child : {}, rest, value),
  };
}

/** Copy of `doc` without `path`; maps left empty by the removal go too. */
function removeAt(doc: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
  const [key, ...rest] = path;
  if (key === undefined || !Object.hasOwn(doc, key)) return doc;
  const { [key]: child, ...others } = doc;
  if (rest.length === 0) return others;
  if (!isPlainObject(child)) return doc;
  const pruned = removeAt(child, rest);
  return Object.keys(pruned).length === 0 ? others : { ...doc, [key]: pruned };
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
