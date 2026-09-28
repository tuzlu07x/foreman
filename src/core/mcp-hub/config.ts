import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { Document, isMap, parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { AGENT_ID_RE } from "../agent-identity.js";
import { SECRET_NAME_PATTERN } from "../secret-store.js";
import { withLockFile } from "./oauth-lock.js";
import { canonicalJson } from "./pins.js";

// =============================================================================
// MCP Hub config — `<configDir>/mcp.yaml`
// =============================================================================
//
// Declares the upstream MCP servers Foreman runs on behalf of every agent
// that connects through `foreman mcp-stdio`. Secrets never live in this
// file: any string value may reference the encrypted secret store with
// `${secret:<name>}`, resolved only when the upstream is spawned.

/** Server names become the tool namespace (`<server>__<tool>`), so they
 *  exclude `_` to keep the separator unambiguous. */
export const SERVER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const TOOL_SEPARATOR = "__";

/** Secret-store names holding hub-managed OAuth sessions. Reserved: mcp.yaml
 *  may not reference them and agents may never read them. */
export const MCP_OAUTH_SECRET_PREFIX = "mcp-oauth-";

export function mcpOAuthSecretName(server: string): string {
  return `${MCP_OAUTH_SECRET_PREFIX}${server}`;
}

export function isMcpOAuthSecretName(name: string): boolean {
  return name.startsWith(MCP_OAUTH_SECRET_PREFIX);
}

const SECRET_REF_RE = new RegExp(`\\$\\{secret:(${SECRET_NAME_PATTERN})\\}`, "g");

/** A secret-store name as `${secret:<name>}` accepts it. */
export const SECRET_NAME_RE = new RegExp(`^${SECRET_NAME_PATTERN}$`);

const GlobListSchema = z.array(z.string().min(1).max(200)).max(200);

export const ToolRulesSchema = z
  .object({
    /** Policy-level allow when policy.yaml has no matching rule. The risk
     *  engine still runs, so a risky call is still escalated. */
    allow: GlobListSchema.optional(),
    /** Always ask a human, unless policy.yaml says otherwise. */
    ask: GlobListSchema.optional(),
    /** Critical tools (merges, pushes, repository changes): a human
     *  confirms every call. Until the hub enforces it (requireHuman), a
     *  confirm rule is evaluated as `ask` — never weaker. */
    confirm: GlobListSchema.optional(),
    /** Never exposed to agents; calls are refused. Wins over every other rule. */
    deny: GlobListSchema.optional(),
  })
  .strict();

/** Department ids as org.yaml spells them. */
export const DEPARTMENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** Who may use a server. Absent = every verified agent (the default for
 *  servers added with `foreman mcp add`); present = the listed agents plus
 *  members of the listed departments; `{}` = nobody. It narrows org.yaml
 *  (`allowedMcpServers`), never widens it. */
export const AccessSchema = z
  .object({
    agents: z.array(z.string().regex(AGENT_ID_RE)).max(200).optional(),
    departments: z.array(z.string().regex(DEPARTMENT_ID_RE)).max(100).optional(),
  })
  .strict();

export const ACCESS_LEVELS = ["read-only", "read-write"] as const;
export type AccessLevelId = (typeof ACCESS_LEVELS)[number];

/** Integration bookkeeping (`foreman integrations`): how the server block
 *  was rendered, so it can be re-rendered on every change. Holds secret
 *  NAMES only, never values. */
export const IntegrationMetaSchema = z
  .object({
    /** Integration id in registry/integrations.json. */
    id: z.string().regex(SERVER_NAME_RE),
    variant: z.string().regex(/^[a-z0-9-]{1,32}$/),
    access_level: z.enum(ACCESS_LEVELS),
    /** Selected products (e.g. jira); absent = all of them. */
    products: z.array(z.string().regex(/^[a-z0-9-]{1,32}$/)).max(20).optional(),
    /** Non-secret values substituted into the catalog entry (e.g. host). */
    params: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), z.string().max(200)).default({}),
    /** Catalog secret slot → secret-store name (a second account uses its
     *  own names, e.g. github-pat → github-pat-work). */
    secrets: z
      .record(z.string().regex(SECRET_NAME_RE), z.string().regex(SECRET_NAME_RE))
      .default({})
      .refine((m) => !Object.values(m).some(isMcpOAuthSecretName), {
        message: `${MCP_OAUTH_SECRET_PREFIX}* names are reserved for hub OAuth sessions`,
      }),
    /** Per-tool rules on top of the catalog's (upstream tool names). */
    tool_overrides: ToolRulesSchema.default({}),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

const ServerConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Catalog entry this server was installed from (informational). */
    catalog_id: z.string().optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    tools: ToolRulesSchema.default({}),
    /** Per-call timeout for this upstream. */
    timeout_seconds: z.number().int().positive().max(3600).default(120),
    /** `oauth`: the hub runs the MCP authorization flow (`foreman mcp
     *  login <name>`) and attaches the bearer token itself. */
    auth: z.enum(["oauth"]).optional(),
    /** Which agents may use this server (see AccessSchema). */
    access: AccessSchema.optional(),
    /** Set when `foreman integrations` manages this server. */
    integration: IntegrationMetaSchema.optional(),
  })
  .strict()
  .refine((s) => Boolean(s.command) !== Boolean(s.url), {
    message: "set exactly one of `command` (stdio) or `url` (streamable HTTP)",
  })
  .refine((s) => !s.url || /^https:\/\//.test(s.url) || isLoopbackUrl(s.url), {
    message: "remote servers must use https:// (plain http is only allowed for localhost)",
  })
  .refine((s) => s.auth !== "oauth" || (Boolean(s.url) && !s.url?.includes("${secret:")), {
    message: "`auth: oauth` needs a plain `url` (streamable HTTP, no ${secret:…} in it)",
  })
  .refine(
    (s) => s.auth !== "oauth" || !Object.keys(s.headers).some((h) => h.toLowerCase() === "authorization"),
    { message: "`auth: oauth` sets the Authorization header itself — remove it from `headers`" },
  )
  .refine((s) => !rawSecretRefs(s).some(isMcpOAuthSecretName), {
    message: `\${secret:${MCP_OAUTH_SECRET_PREFIX}…} is reserved for hub OAuth sessions and cannot be referenced`,
  });

const LimitsSchema = z
  .object({
    /** Tool results longer than this are truncated before reaching the agent. */
    max_result_chars: z.number().int().min(1_000).max(1_000_000).default(24_000),
    /** Tool + parameter descriptions are clipped to this many characters. */
    max_description_chars: z.number().int().min(40).max(10_000).default(400),
    /** In `auto` mode, switch to lazy discovery above this many tools. */
    lazy_threshold: z.number().int().min(0).max(10_000).default(40),
  })
  .strict();

const SecurityOptionsSchema = z
  .object({
    /** Hide tools whose definitions look like prompt injection. */
    quarantine_suspicious_tools: z.boolean().default(true),
    /** Pin tool definitions on first use; hide tools whose definition changes. */
    pin_tool_definitions: z.boolean().default(true),
    /** Mask credential-shaped strings in tool results. */
    redact_secrets_in_results: z.boolean().default(true),
    /** Prefix a warning when a result contains instruction-like text. */
    flag_injection_in_results: z.boolean().default(true),
  })
  .strict();

export const HubConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    /** eager = every tool is listed; lazy = two meta-tools (search + call);
     *  auto = eager until `limits.lazy_threshold` tools, then lazy. */
    mode: z.enum(["auto", "eager", "lazy"]).default("auto"),
    limits: LimitsSchema.default({}),
    security: SecurityOptionsSchema.default({}),
    servers: z.record(z.string(), ServerConfigSchema).default({}),
  })
  .strict()
  .superRefine((doc, ctx) => {
    for (const name of Object.keys(doc.servers)) {
      if (!SERVER_NAME_RE.test(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["servers", name],
          message:
            "server names must be lowercase letters, digits or '-' (max 32 chars)",
        });
      }
    }
  });

export type HubConfig = z.infer<typeof HubConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ServerConfigInput = z.input<typeof ServerConfigSchema>;
export type ToolRules = z.infer<typeof ToolRulesSchema>;
export type ServerAccess = z.infer<typeof AccessSchema>;
export type IntegrationMeta = z.infer<typeof IntegrationMetaSchema>;
export type HubMode = HubConfig["mode"];

export function defaultHubConfig(): HubConfig {
  return HubConfigSchema.parse({});
}

export function parseHubConfigText(text: string): HubConfig {
  const parsed: unknown = text.trim().length === 0 ? {} : parseYaml(text);
  return HubConfigSchema.parse(parsed ?? {});
}

export function loadHubConfig(path: string): HubConfig {
  if (!existsSync(path)) return defaultHubConfig();
  return parseHubConfigText(readFileSync(path, "utf-8"));
}

const HEADER = `# Foreman MCP Hub — upstream MCP servers shared by every agent that
# connects through \`foreman mcp-stdio\`. Every tool call is mediated
# (policy, risk, approval, audit) before it reaches the server.
# Reference secrets with \${secret:<name>} — never paste raw tokens here.
# Docs: docs/mcp-hub.md
`;

export function saveHubConfig(path: string, config: HubConfig): void {
  const body = stringifyYaml(HubConfigSchema.parse(config), { lineWidth: 100 });
  writeFileSync(path, `${HEADER}\n${body}`, { encoding: "utf-8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort on filesystems without POSIX modes
  }
}

// -----------------------------------------------------------------------------
// Locked, atomic, comment-preserving writes
// -----------------------------------------------------------------------------

export interface HubConfigUpdate {
  before: HubConfig;
  after: HubConfig;
  /** False when the edit changed nothing (the file was not rewritten). */
  changed: boolean;
}

export interface UpdateHubConfigOptions {
  /** Give up waiting for another writer after this long. */
  lockWaitMs?: number;
}

/** The lock every mcp.yaml writer takes. */
export function hubConfigLockPath(mcpConfigPath: string): string {
  return `${mcpConfigPath}.lock`;
}

/**
 * The one way to change mcp.yaml: take `mcp.yaml.lock`, read the current
 * file, apply `edit`, validate, then write a 0600 temp file, fsync it and
 * rename it over the original. Concurrent writers (the CLI, the TUI, `foreman
 * start`) therefore never lose each other's changes, and a crash never
 * leaves a half-written file.
 *
 * Comments and key order survive: the edit is applied to the parsed YAML
 * document as a minimal diff (changed keys only), so a hand-written comment
 * on an untouched server stays where it was. Comments inside a list or
 * value that the edit replaces are lost with it. If the diff cannot be
 * applied faithfully (checked by re-parsing), the file is rewritten from the
 * validated config instead, which drops comments.
 *
 * `edit` must be pure and quick — it runs under the lock. Throwing from it
 * aborts the update and leaves the file untouched. An existing mcp.yaml that
 * does not validate is never overwritten: fix it by hand first.
 */
export async function updateHubConfig(
  paths: { mcpConfigPath: string },
  edit: (current: HubConfig) => HubConfig | Promise<HubConfig>,
  opts: UpdateHubConfigOptions = {},
): Promise<HubConfigUpdate> {
  const path = paths.mcpConfigPath;
  return withLockFile(
    hubConfigLockPath(path),
    async () => {
      const text = existsSync(path) ? readFileSync(path, "utf-8") : null;
      const before = text === null ? defaultHubConfig() : parseHubConfigText(text);
      const after = HubConfigSchema.parse(await edit(structuredClone(before)));
      if (canonicalJson(after) === canonicalJson(before)) return { before, after, changed: false };
      writeFileAtomic(path, renderHubConfigText(text, before, after));
      return { before, after, changed: true };
    },
    { label: "the mcp.yaml lock", ...(opts.lockWaitMs !== undefined ? { waitMs: opts.lockWaitMs } : {}) },
  );
}

/** New file text for `after`, keeping `current`'s comments where it can. */
export function renderHubConfigText(current: string | null, before: HubConfig, after: HubConfig): string {
  const fresh = `${HEADER}\n${stringifyYaml(compactForYaml(after), { lineWidth: 100 })}`;
  if (current === null || current.trim().length === 0) return fresh;
  const doc = parseDocument(current);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return fresh;
  syncYamlNode(doc, [], compactForYaml(before), compactForYaml(after));
  const text = doc.toString({ lineWidth: 100 });
  try {
    if (canonicalJson(parseHubConfigText(text)) === canonicalJson(after)) return text;
  } catch {
    // fall through to a clean rewrite
  }
  return fresh;
}

/** The config without per-server fields that only repeat a schema
 *  default (empty args / env / headers / tools, the default timeout), so
 *  new blocks stay short. Only defaults that parse back identically are
 *  dropped — `access: {}` (nobody) is never touched. */
function compactForYaml(config: HubConfig): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(config.servers)) {
    const out: Record<string, unknown> = { ...server };
    for (const key of ["args", "env", "headers", "tools"] as const) {
      const value = server[key];
      if (Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0) delete out[key];
    }
    if (server.timeout_seconds === 120) delete out.timeout_seconds;
    if (server.integration) {
      const meta: Record<string, unknown> = { ...server.integration };
      for (const key of ["params", "secrets", "tool_overrides"] as const) {
        if (Object.keys(server.integration[key]).length === 0) delete meta[key];
      }
      out.integration = meta;
    }
    servers[name] = out;
  }
  return { ...config, servers };
}

/** Apply the difference between two plain values to a YAML document,
 *  recursing into maps so untouched keys (and their comments) stay put. */
function syncYamlNode(doc: Document, path: string[], before: unknown, after: unknown): void {
  if (canonicalJson(before) === canonicalJson(after)) return;
  const node = path.length === 0 ? doc.contents : doc.getIn(path, true);
  // A flow map (`servers: {}`) is replaced whole, so new entries come out
  // in block style.
  if (isPlainObject(before) && isPlainObject(after) && isMap(node) && !node.flow) {
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(after, key)) doc.deleteIn([...path, key]);
    }
    for (const [key, value] of Object.entries(after)) {
      syncYamlNode(doc, [...path, key], before[key], value);
    }
    return;
  }
  if (after === undefined) doc.deleteIn(path);
  else doc.setIn(path, doc.createNode(after));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Write via a 0600 temp file in the same directory, fsync, then rename. */
function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeSync(fd, text, null, "utf-8");
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw err;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort on filesystems without POSIX modes
  }
  try {
    const dirFd = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // not every platform lets a directory be fsynced
  }
}

export function enabledServers(config: HubConfig): Array<[string, ServerConfig]> {
  return Object.entries(config.servers).filter(([, s]) => s.enabled);
}

// -----------------------------------------------------------------------------
// Secret references
// -----------------------------------------------------------------------------

export class MissingSecretError extends Error {
  constructor(
    public readonly server: string,
    public readonly secretName: string,
  ) {
    super(
      `MCP server '${server}' needs secret '${secretName}' — run \`foreman secrets add ${secretName}\``,
    );
    this.name = "MissingSecretError";
  }
}

/** Every `${secret:<name>}` referenced by a server's env / headers / args. */
export function referencedSecrets(server: ServerConfig): string[] {
  return rawSecretRefs(server);
}

function rawSecretRefs(server: {
  env: Record<string, string>;
  headers: Record<string, string>;
  args: string[];
  url?: string | undefined;
}): string[] {
  const names = new Set<string>();
  const scan = (value: string): void => {
    for (const m of value.matchAll(SECRET_REF_RE)) names.add(m[1]!);
  };
  for (const v of Object.values(server.env)) scan(v);
  for (const v of Object.values(server.headers)) scan(v);
  for (const v of server.args) scan(v);
  if (server.url) scan(server.url);
  return [...names];
}

/** Replace `${secret:<name>}` with the stored value. The resolver returns
 *  `null` for a missing secret, which fails the whole server closed. */
export function resolveSecretRefs(
  serverName: string,
  value: string,
  resolve: (name: string) => string | null,
): string {
  return value.replace(SECRET_REF_RE, (_match, name: string) => {
    const secret = resolve(name);
    if (secret === null) throw new MissingSecretError(serverName, name);
    return secret;
  });
}

// -----------------------------------------------------------------------------
// Tool rules
// -----------------------------------------------------------------------------

export type ToolRuleEffect = "allow" | "ask" | "deny";

/** Every rule level, strongest first: deny > confirm > ask > allow. */
export type ToolRuleLevel = "deny" | "confirm" | "ask" | "allow";

/** `*` matches any run of characters; everything else is literal. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

export function matchesAnyGlob(name: string, globs: readonly string[] | undefined): boolean {
  if (!globs || globs.length === 0) return false;
  return globs.some((g) => globToRegExp(g).test(name));
}

/** deny > confirm > ask > allow; `null` when no rule mentions the tool. */
export function toolRuleLevel(rules: ToolRules, toolName: string): ToolRuleLevel | null {
  if (matchesAnyGlob(toolName, rules.deny)) return "deny";
  if (matchesAnyGlob(toolName, rules.confirm)) return "confirm";
  if (matchesAnyGlob(toolName, rules.ask)) return "ask";
  if (matchesAnyGlob(toolName, rules.allow)) return "allow";
  return null;
}

/** The effect the hub applies today. A `confirm` rule counts as `ask`
 *  (and so still beats any allow rule) until the hub enforces
 *  requireHuman for it. */
export function toolRuleEffect(rules: ToolRules, toolName: string): ToolRuleEffect | null {
  const level = toolRuleLevel(rules, toolName);
  return level === "confirm" ? "ask" : level;
}

function isLoopbackUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === "http:" &&
      (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}
