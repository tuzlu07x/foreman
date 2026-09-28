import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SERVER_NAME_RE, type ServerConfigInput } from "./config.js";

// =============================================================================
// Bundled MCP server catalog — `registry/mcp-servers.json`
// =============================================================================
//
// Curated, verified entries for popular MCP servers so `foreman mcp add
// github` is one command instead of a README hunt. Every entry ships with a
// safe default tool policy: read-only tools are policy-allowed (the risk
// engine still runs), anything that writes, sends, pays or deletes asks.

/** A validation pattern shipped in a catalog: anchored, and compilable. */
export const AnchoredPatternSchema = z
  .string()
  .min(2)
  .max(300)
  .refine(isAnchoredRegExp, { message: "must be a valid regular expression anchored with ^…$" });

const SecretSpecSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    description: z.string().min(1),
    where_to_get: z.string().url().optional(),
    /** What a valid value looks like, for prompts ("starts with lin_api_"). */
    format_hint: z.string().min(1).max(200).optional(),
    /** Values that do not match are refused when entered. */
    pattern: AnchoredPatternSchema.optional(),
  })
  .strict();

/** Name of a `${param:<name>}` placeholder. */
export const PARAM_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const PARAM_REF_RE = /\$\{param:([a-z][a-z0-9_]{0,31})\}/g;

/** A non-secret value the user supplies when adding the server (e.g. the
 *  GitLab host), substituted for `${param:<name>}` at add time. */
const UserParamSchema = z
  .object({
    name: z.string().regex(PARAM_NAME_RE),
    label: z.string().min(1).max(80),
    default: z.string().min(1).max(200).optional(),
    example: z.string().min(1).max(200),
    pattern: AnchoredPatternSchema,
  })
  .strict()
  .superRefine((p, ctx) => {
    if (!isAnchoredRegExp(p.pattern)) return;
    const re = new RegExp(p.pattern);
    for (const [field, value] of [
      ["example", p.example],
      ["default", p.default],
    ] as const) {
      if (value !== undefined && !re.test(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `param '${p.name}': ${field} does not match its pattern` });
      }
    }
  });

const CatalogToolRulesSchema = z
  .object({
    allow: z.array(z.string().min(1)).optional(),
    ask: z.array(z.string().min(1)).optional(),
    /** A human confirms every call (merges, pushes). */
    confirm: z.array(z.string().min(1)).optional(),
    deny: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const McpCatalogEntrySchema = z
  .object({
    id: z.string().regex(SERVER_NAME_RE, "id must be lowercase kebab-case (max 32 chars)"),
    name: z.string().min(1),
    description: z.string().min(1),
    category: z.enum([
      "developer",
      "productivity",
      "communication",
      "data",
      "search",
      "browser",
      "cloud",
      "payments",
      "media",
      "travel",
      "commerce",
      "utility",
    ]),
    publisher: z.string().min(1),
    official: z.boolean(),
    homepage: z.string().url(),
    /** Runtime the user needs locally (node → npx, python → uvx, docker). */
    requires: z.array(z.enum(["node", "python-uv", "docker"])).default([]),
    transport: z.enum(["stdio", "http"]),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    /** May hold `${param:<name>}` placeholders (see user_params). */
    url: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).default({}),
    /** `oauth`: hosted server signed in with the MCP authorization flow. */
    auth: z.enum(["oauth"]).optional(),
    secrets: z.array(SecretSpecSchema).default([]),
    /** Non-secret values asked for at add time (`${param:<name>}`). */
    user_params: z.array(UserParamSchema).default([]),
    /** Extra positional args the user must supply (e.g. allowed dirs). */
    user_args: z
      .object({ description: z.string().min(1), example: z.array(z.string()).min(1) })
      .strict()
      .optional(),
    tools: CatalogToolRulesSchema.default({}),
    notes: z.string().optional(),
    /** `beta`: the provider calls it beta. `unverified`: Foreman could not
     *  confirm it works with the hub (e.g. OAuth client registration). */
    status: z.enum(["beta", "unverified"]).optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    const issue = (message: string): void => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (e.transport === "stdio" && !e.command) issue("stdio entries need `command`");
    if (e.transport === "http" && !e.url) issue("http entries need `url`");
    if (e.transport === "stdio" && (e.url || Object.keys(e.headers).length > 0 || e.auth)) {
      issue("stdio entries take no url, headers or auth");
    }
    if (e.transport === "http" && (e.command || e.args.length > 0 || Object.keys(e.env).length > 0)) {
      issue("http entries take no command, args or env");
    }
    const declared = new Set(e.secrets.map((s) => s.name));
    const blob = JSON.stringify([e.env, e.headers, e.args, e.url ?? ""]);
    for (const m of blob.matchAll(/\$\{secret:([^}]+)\}/g)) {
      if (!declared.has(m[1]!)) issue(`references undeclared secret '${m[1]}'`);
    }
    if (e.auth === "oauth") {
      if (e.url?.includes("${secret:")) issue("`auth: oauth` needs a url without ${secret:…}");
      if (Object.keys(e.headers).some((h) => h.toLowerCase() === "authorization")) {
        issue("`auth: oauth` sets the Authorization header itself");
      }
    }
    // Parameters: every placeholder declared, every declaration used, none
    // in the command, and in a URL only as the whole host[:port].
    const params = new Set(e.user_params.map((p) => p.name));
    if (params.size !== e.user_params.length) issue("duplicate user_params name");
    if (e.command?.includes("${param:")) issue("`command` may not use ${param:…}");
    const used = new Set<string>();
    for (const value of catalogTemplates(e)) {
      if (/\$\{param:(?![a-z][a-z0-9_]{0,31}\})/.test(value)) issue(`malformed \${param:…} in '${value}'`);
      for (const m of value.matchAll(PARAM_REF_RE)) {
        used.add(m[1]!);
        if (!params.has(m[1]!)) issue(`references undeclared param '${m[1]}'`);
      }
      if (value.includes("://") && value.includes("${param:") && !URL_PARAM_TEMPLATE_RE.test(value)) {
        issue(`'${value}': in a URL a parameter may only be the whole host, as https://\${param:host}/…`);
      }
    }
    for (const name of params) if (!used.has(name)) issue(`param '${name}' is declared but never used`);
    if (e.url !== undefined && !e.url.includes("${param:") && !/^https?:\/\/[^\s]+$/.test(e.url)) {
      issue("`url` must be an http(s) URL");
    }
  });

export const McpCatalogSchema = z
  .object({
    version: z.literal(1),
    servers: z.array(McpCatalogEntrySchema),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const seen = new Set<string>();
    for (const s of doc.servers) {
      if (seen.has(s.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate id '${s.id}'` });
      }
      seen.add(s.id);
    }
  });

export type McpCatalogEntry = z.infer<typeof McpCatalogEntrySchema>;
export type McpCatalog = z.infer<typeof McpCatalogSchema>;

export class McpCatalogError extends Error {
  constructor(
    message: string,
    public readonly issues: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
    this.name = "McpCatalogError";
  }
}

export function resolveBundledMcpCatalogPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "..", "registry", "mcp-servers.json"),
    resolve(here, "..", "..", "registry", "mcp-servers.json"),
    resolve(here, "..", "registry", "mcp-servers.json"),
    resolve(process.cwd(), "registry", "mcp-servers.json"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export function parseMcpCatalogText(text: string): McpCatalog {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new McpCatalogError(
      `registry/mcp-servers.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = McpCatalogSchema.safeParse(raw);
  if (!parsed.success) {
    throw new McpCatalogError(
      "registry/mcp-servers.json failed schema validation",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return parsed.data;
}

export function loadBundledMcpCatalog(): McpCatalog {
  const path = resolveBundledMcpCatalogPath();
  if (!path) throw new McpCatalogError("bundled registry/mcp-servers.json not found");
  return parseMcpCatalogText(readFileSync(path, "utf-8"));
}

export function findCatalogEntry(catalog: McpCatalog, id: string): McpCatalogEntry | null {
  return catalog.servers.find((s) => s.id === id) ?? null;
}

/** Turn a catalog entry into an mcp.yaml server block. `params` fills the
 *  entry's `${param:…}` placeholders (defaults apply); see
 *  resolveCatalogParams for what a value may contain. */
export function serverConfigFromCatalog(
  entry: McpCatalogEntry,
  extraArgs: readonly string[] = [],
  params: Readonly<Record<string, string>> = {},
): ServerConfigInput {
  const values = resolveCatalogParams(entry, params);
  const fill = (template: string): string => fillTemplate(entry, template, values);
  const base: ServerConfigInput = {
    enabled: true,
    catalog_id: entry.id,
    tools: cloneToolRules(entry.tools),
    ...(entry.auth ? { auth: entry.auth } : {}),
  };
  if (entry.transport === "http") {
    return { ...base, url: fill(entry.url!), headers: mapRecord(entry.headers, fill) };
  }
  return {
    ...base,
    command: entry.command!,
    args: [...entry.args.map(fill), ...extraArgs],
    env: mapRecord(entry.env, fill),
  };
}

// -----------------------------------------------------------------------------
// ${param:…} substitution
// -----------------------------------------------------------------------------

export class CatalogParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogParamError";
  }
}

/** In a URL a parameter may only be the whole authority. */
const URL_PARAM_TEMPLATE_RE = /^https:\/\/\$\{param:[a-z][a-z0-9_]{0,31}\}(?:\/[^$]*)?$/;
/** Hard limit for a host parameter, whatever the catalog pattern allows:
 *  no userinfo, path, query, fragment or scheme can be smuggled in. */
const HOST_PARAM_RE = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;

/** The value of every declared parameter: supplied, else its default.
 *  Unknown names, missing values and unsafe values are refused. */
export function resolveCatalogParams(
  entry: McpCatalogEntry,
  provided: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const declared = new Map(entry.user_params.map((p) => [p.name, p]));
  for (const key of Object.keys(provided)) {
    if (!declared.has(key)) {
      const known = entry.user_params.map((p) => p.name).join(", ") || "none";
      throw new CatalogParamError(`${entry.name} has no parameter '${key}' (parameters: ${known})`);
    }
  }
  const hostParams = new Set<string>();
  for (const template of catalogTemplates(entry)) {
    const m = /^https:\/\/\$\{param:([a-z][a-z0-9_]{0,31})\}/.exec(template);
    if (m) hostParams.add(m[1]!);
  }
  const out: Record<string, string> = {};
  for (const spec of entry.user_params) {
    const raw = provided[spec.name] ?? spec.default;
    if (raw === undefined) {
      throw new CatalogParamError(
        `${entry.name} needs ${spec.label.toLowerCase()} — pass ${spec.name}=… (e.g. ${spec.example})`,
      );
    }
    const trimmed = raw.trim();
    // Hosts compare case-insensitively and :443 is implied by https.
    const value = hostParams.has(spec.name) ? trimmed.toLowerCase().replace(/:443$/, "") : trimmed;
    const bad = (why: string): CatalogParamError =>
      new CatalogParamError(`${spec.label} '${printable(value)}' is not valid: ${why}`);
    if (value.length === 0 || value.length > 200) throw bad("must be 1–200 characters");
    if (/[\s\u0000-\u001f\u007f]/.test(value)) throw bad("no spaces or control characters");
    if (value.includes("${")) throw bad("no ${…} references");
    if (!new RegExp(spec.pattern).test(value)) throw bad(`expected something like ${spec.example}`);
    if (hostParams.has(spec.name)) {
      if (!HOST_PARAM_RE.test(value)) throw bad("a host name (and optional :port) only");
      const port = /:(\d+)$/.exec(value)?.[1];
      if (port !== undefined && (Number(port) < 1 || Number(port) > 65_535)) throw bad("port out of range");
    }
    out[spec.name] = value;
  }
  return out;
}

/** Fill one template. A URL-shaped template must still be the same https
 *  URL afterwards: scheme, path, query and fragment exactly as the catalog
 *  wrote them, the parameter as the whole host, and no userinfo. */
function fillTemplate(entry: McpCatalogEntry, template: string, values: Readonly<Record<string, string>>): string {
  if (!template.includes("${param:")) return template;
  const filled = template.replace(PARAM_REF_RE, (_m, name: string) => {
    const value = values[name];
    if (value === undefined) throw new CatalogParamError(`${entry.name}: no value for param '${name}'`);
    return value;
  });
  const host = /^https:\/\/\$\{param:([a-z][a-z0-9_]{0,31})\}/.exec(template)?.[1];
  if (host === undefined) return filled;
  const reference = template.replace(PARAM_REF_RE, "example.invalid");
  let actual: URL;
  let expected: URL;
  try {
    actual = new URL(filled);
    expected = new URL(reference);
  } catch {
    throw new CatalogParamError(`${entry.name}: '${printable(values[host]!)}' does not make a valid URL`);
  }
  const same =
    actual.protocol === "https:" &&
    actual.username === "" &&
    actual.password === "" &&
    actual.host === values[host] &&
    actual.pathname === expected.pathname &&
    actual.search === expected.search &&
    actual.hash === expected.hash;
  if (!same) {
    throw new CatalogParamError(
      `${entry.name}: '${printable(values[host]!)}' would change the server URL beyond its host — give a host name only`,
    );
  }
  return filled;
}

/** Every string of an entry that may hold `${param:…}`. */
function catalogTemplates(e: Pick<McpCatalogEntry, "url" | "headers" | "env" | "args">): string[] {
  return [...(e.url ? [e.url] : []), ...Object.values(e.headers), ...Object.values(e.env), ...e.args];
}

function cloneToolRules(rules: McpCatalogEntry["tools"]): ServerConfigInput["tools"] {
  const out: NonNullable<ServerConfigInput["tools"]> = {};
  for (const key of ["allow", "ask", "confirm", "deny"] as const) {
    const list = rules[key];
    if (list) out[key] = [...list];
  }
  return out;
}

function mapRecord(input: Record<string, string>, fn: (v: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) out[k] = fn(v);
  return out;
}

function printable(value: string): string {
  const clipped = value.length > 80 ? `${value.slice(0, 79)}…` : value;
  return clipped.replace(/[\u0000-\u001f\u007f]/g, "?");
}

export function isAnchoredRegExp(pattern: string): boolean {
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}
