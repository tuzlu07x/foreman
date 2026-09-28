import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { isReservedSecretName } from "../secret-store.js";
import {
  AnchoredPatternSchema,
  findCatalogEntry,
  isAnchoredRegExp,
  type McpCatalog,
  type McpCatalogEntry,
} from "../mcp-hub/catalog.js";
import {
  ACCESS_LEVELS,
  isMcpOAuthSecretName,
  SECRET_NAME_RE,
  SERVER_NAME_RE,
  toolRuleLevel,
  type AccessLevelId,
} from "../mcp-hub/config.js";

// =============================================================================
// Integration catalog — `registry/integrations.json`
// =============================================================================
//
// A product-level layer over the MCP server catalog (mcp-servers.json):
// "GitHub" rather than "the github server with a PAT header". Each
// integration offers one or more variants (hosted OAuth, token, local
// Docker, community package), each mapping 1:1 onto a catalog server, and
// access levels that only add tool rules (plus headers / env) — never a
// different URL, command or args, so an OAuth token is never re-pointed.

export const INTEGRATION_CATEGORIES = ["code", "project", "docs", "observability", "chat"] as const;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

const GlobListSchema = z.array(z.string().min(1).max(200)).max(200);

const IntegrationToolRulesSchema = z
  .object({
    allow: GlobListSchema.optional(),
    ask: GlobListSchema.optional(),
    confirm: GlobListSchema.optional(),
    deny: GlobListSchema.optional(),
  })
  .strict();

const SecretFieldSchema = z
  .object({
    /** Secret name as the catalog server declares it (the slot). */
    secret: z.string().regex(SECRET_NAME_RE),
    label: z.string().min(1).max(80),
    where_to_get: z.string().url(),
    format_hint: z.string().min(1).max(200),
    pattern: AnchoredPatternSchema.optional(),
    setup_steps: z.array(z.string().min(1)).min(1),
  })
  .strict();

const AuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("secrets"), fields: z.array(SecretFieldSchema).min(1) }).strict(),
  z
    .object({
      /** One secret holding base64(user:password) for `Authorization: Basic`. */
      kind: z.literal("basic"),
      secret: z.string().regex(SECRET_NAME_RE),
      username_label: z.string().min(1).max(80),
      password_label: z.string().min(1).max(80),
      where_to_get: z.string().url(),
      format_hint: z.string().min(1).max(200),
      setup_steps: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("oauth"),
      /** Scopes to request; absent = the server's default grant. */
      scope: z.string().min(1).max(200).optional(),
    })
    .strict(),
]);

/** What an access level may change: tool rules, and headers / env only. */
const AccessLevelSchema = z
  .object({
    description: z.string().min(1).max(200).optional(),
    tools: IntegrationToolRulesSchema.default({}),
    headers: z.record(z.string().min(1), z.string()).default({}),
    env: z.record(z.string().min(1), z.string()).default({}),
  })
  .strict();

const HealthCheckSchema = z.object({ tool: z.string().min(1).max(100) }).strict();

const VariantSchema = z
  .object({
    id: z.string().regex(SLUG_RE),
    label: z.string().min(1).max(80),
    description: z.string().min(1).max(300).optional(),
    /** Catalog server id in registry/mcp-servers.json. */
    server: z.string().regex(SERVER_NAME_RE),
    recommended: z.boolean().default(false),
    auth: AuthSchema,
    default_access_level: z.enum(ACCESS_LEVELS),
    access_levels: z
      .object({ "read-only": AccessLevelSchema.optional(), "read-write": AccessLevelSchema.optional() })
      .strict(),
    health_check: HealthCheckSchema.optional(),
    /** Where the user removes Foreman's access at the provider. */
    revoke_url: z.string().url().optional(),
    notes: z.string().min(1).optional(),
  })
  .strict();

const ProductSchema = z
  .object({
    id: z.string().regex(SLUG_RE),
    label: z.string().min(1).max(80),
    /** Tools that belong to this product; denied when it is not selected. */
    tools: z.array(z.string().min(1).max(200)).min(1),
  })
  .strict();

export const IntegrationEntrySchema = z
  .object({
    id: z.string().regex(SERVER_NAME_RE),
    name: z.string().min(1).max(80),
    aliases: z.array(z.string().regex(SLUG_RE)).default([]),
    category: z.enum(INTEGRATION_CATEGORIES),
    description: z.string().min(1).max(300),
    homepage: z.string().url(),
    /** Agents pre-selected in the "who can use it" step. */
    used_by_agents: z.array(z.string().min(1)).default([]),
    products: z.array(ProductSchema).default([]),
    /** Tools that reach every product (search, generic execute): denied as
     *  soon as the selection leaves any product out. */
    cross_product_tools: z.array(z.string().min(1).max(200)).default([]),
    health_check: HealthCheckSchema.optional(),
    variants: z.array(VariantSchema).min(1),
  })
  .strict();

export const IntegrationCatalogSchema = z
  .object({
    version: z.literal(1),
    integrations: z.array(IntegrationEntrySchema),
  })
  .strict();

export type IntegrationCatalog = z.infer<typeof IntegrationCatalogSchema>;
export type IntegrationEntry = z.infer<typeof IntegrationEntrySchema>;
export type IntegrationVariant = z.infer<typeof VariantSchema>;
export type IntegrationAuth = z.infer<typeof AuthSchema>;
export type IntegrationAccessLevel = z.infer<typeof AccessLevelSchema>;
export type IntegrationProduct = z.infer<typeof ProductSchema>;
export type IntegrationSecretField = z.infer<typeof SecretFieldSchema>;

export class IntegrationCatalogError extends Error {
  constructor(
    message: string,
    public readonly issues: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
    this.name = "IntegrationCatalogError";
  }
}

/** Secret names the notification channels use by convention (notify.yaml
 *  `*_ref`). An integration must never share one: hub secrets are kept
 *  away from agents, notification tokens are not. */
export const NOTIFY_SECRET_NAMES: ReadonlySet<string> = new Set([
  "telegram-bot-token",
  "telegram-approval-bot-token",
  "telegram-chat-id",
  "discord-bot-token",
  "slack-bot-token",
  "slack-app-token",
  "ntfy-topic",
  "ntfy-access-token",
  "webhook-url",
  "webhook-signing-secret",
  "smtp-password",
]);

export interface CatalogValidationContext {
  mcp: McpCatalog;
  /** Agent ids in registry/agents.json. */
  agentIds: ReadonlySet<string>;
  /** Secret names integrations may not use (defaults to NOTIFY_SECRET_NAMES). */
  reservedSecretNames?: ReadonlySet<string>;
}

export interface CatalogIssue {
  path: string;
  message: string;
}

/** Every rule an integration catalog must satisfy beyond its schema. */
export function validateIntegrationCatalog(doc: IntegrationCatalog, ctx: CatalogValidationContext): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const add = (path: string, message: string): void => void issues.push({ path, message });
  const reserved = ctx.reservedSecretNames ?? NOTIFY_SECRET_NAMES;
  const names = new Map<string, string>();
  const claim = (name: string, owner: string, path: string): void => {
    const prior = names.get(name);
    if (prior !== undefined && prior !== owner) add(path, `'${name}' is already used by ${prior}`);
    else names.set(name, owner);
  };
  for (const [i, entry] of doc.integrations.entries()) {
    const at = `integrations.${i}(${entry.id})`;
    claim(entry.id, `integration '${entry.id}'`, at);
    for (const alias of entry.aliases) claim(alias, `integration '${entry.id}'`, `${at}.aliases`);
    for (const agent of entry.used_by_agents) {
      if (!ctx.agentIds.has(agent)) add(`${at}.used_by_agents`, `unknown agent '${agent}'`);
    }
    uniqueIds(entry.products.map((p) => p.id), `${at}.products`, add);
    uniqueIds(entry.variants.map((v) => v.id), `${at}.variants`, add);
    for (const product of entry.products) checkNoWildcard(product.tools, `${at}.products.${product.id}.tools`, add);
    if (entry.products.length < 2 && entry.cross_product_tools.length > 0) {
      add(`${at}.cross_product_tools`, "only meaningful with two or more products");
    }
    const recommended = entry.variants.filter((v) => v.recommended);
    if (recommended.length !== 1) add(`${at}.variants`, "exactly one variant must be recommended");
    for (const variant of entry.variants) {
      validateVariant(entry, variant, `${at}.variants.${variant.id}`, ctx.mcp, reserved, add);
    }
  }
  return issues;
}

function validateVariant(
  entry: IntegrationEntry,
  variant: IntegrationVariant,
  at: string,
  mcp: McpCatalog,
  reserved: ReadonlySet<string>,
  add: (path: string, message: string) => void,
): void {
  const server = findCatalogEntry(mcp, variant.server);
  if (!server) {
    add(`${at}.server`, `no server '${variant.server}' in registry/mcp-servers.json`);
    return;
  }
  if (server.user_args) add(`${at}.server`, `'${server.id}' needs positional args, which integrations cannot supply`);
  if (variant.recommended && server.status === "unverified") {
    add(`${at}.recommended`, `'${server.id}' is unverified and cannot be the recommended variant`);
  }
  const declared = new Set(server.secrets.map((s) => s.name));
  const covered = new Set<string>();
  switch (variant.auth.kind) {
    case "none":
      if (server.auth === "oauth" || declared.size > 0) add(`${at}.auth`, `'${server.id}' needs credentials`);
      break;
    case "oauth":
      if (server.transport !== "http" || server.auth !== "oauth") {
        add(`${at}.auth`, `oauth needs an http server with \`auth: oauth\` ('${server.id}' is not)`);
      }
      break;
    case "secrets":
      if (server.auth === "oauth") add(`${at}.auth`, `'${server.id}' signs in with OAuth`);
      for (const field of variant.auth.fields) {
        covered.add(field.secret);
        if (!declared.has(field.secret)) add(`${at}.auth`, `secret '${field.secret}' is not declared on '${server.id}'`);
        if (field.pattern && !isAnchoredRegExp(field.pattern)) add(`${at}.auth`, `bad pattern for '${field.secret}'`);
      }
      break;
    case "basic": {
      covered.add(variant.auth.secret);
      const header = Object.entries(server.headers).find(([k]) => k.toLowerCase() === "authorization")?.[1];
      if (!declared.has(variant.auth.secret) || header !== `Basic \${secret:${variant.auth.secret}}`) {
        add(`${at}.auth`, `basic needs '${server.id}' to send Authorization: Basic \${secret:${variant.auth.secret}}`);
      }
      break;
    }
  }
  for (const name of declared) {
    if (!covered.has(name)) add(`${at}.auth`, `'${server.id}' needs secret '${name}', which the variant never asks for`);
    if (reserved.has(name) || isReservedSecretName(name) || isMcpOAuthSecretName(name)) {
      add(`${at}.auth`, `secret name '${name}' is reserved (notification channel or Foreman internal)`);
    }
  }
  checkServerRules(server, `${at}.server`, add);
  if (!variant.access_levels[variant.default_access_level]) {
    add(`${at}.default_access_level`, `no '${variant.default_access_level}' access level`);
  }
  if (!variant.access_levels["read-only"]) add(`${at}.access_levels`, "every variant needs a read-only level");
  const params = new Set(server.user_params.map((p) => p.name));
  for (const level of ACCESS_LEVELS) {
    const spec = variant.access_levels[level];
    if (!spec) continue;
    const lat = `${at}.access_levels.${level}`;
    checkNoWildcard(spec.tools.allow, `${lat}.tools.allow`, add);
    checkNoWildcard(spec.tools.ask, `${lat}.tools.ask`, add);
    if (server.transport === "stdio" && Object.keys(spec.headers).length > 0) add(lat, "a stdio server takes no headers");
    if (server.transport === "http" && Object.keys(spec.env).length > 0) add(lat, "an http server takes no env");
    for (const [key, value] of [...Object.entries(spec.headers), ...Object.entries(spec.env)]) {
      if (key.toLowerCase() === "authorization" || value.includes("${secret:")) {
        add(lat, `'${key}': credentials come from the server entry, not an access level`);
      }
      for (const m of value.matchAll(/\$\{param:([^}]*)\}/g)) {
        if (!params.has(m[1]!)) add(lat, `'${key}' references undeclared param '${m[1]}'`);
      }
    }
    for (const key of Object.keys(spec.headers)) {
      if (Object.keys(server.headers).some((h) => h.toLowerCase() === key.toLowerCase())) {
        add(lat, `header '${key}' would override the server's own`);
      }
    }
    for (const key of Object.keys(spec.env)) {
      if (Object.hasOwn(server.env, key)) add(lat, `env '${key}' would override the server's own`);
    }
  }
  const health = variant.health_check ?? entry.health_check;
  const readOnly = variant.access_levels["read-only"];
  if (health && readOnly) {
    const level = toolRuleLevel(mergeRuleLists(server.tools, readOnly.tools), health.tool);
    if (level === "deny") add(`${at}.health_check`, `'${health.tool}' is denied at read-only`);
  }
}

function checkServerRules(server: McpCatalogEntry, at: string, add: (path: string, message: string) => void): void {
  checkNoWildcard(server.tools.allow, `${at}.tools.allow`, add);
  checkNoWildcard(server.tools.ask, `${at}.tools.ask`, add);
}

/** `allow: ["*"]` would auto-approve every tool the server ever adds, and
 *  `ask: ["*"]` would override every narrower allow. */
function checkNoWildcard(list: readonly string[] | undefined, at: string, add: (path: string, message: string) => void): void {
  for (const glob of list ?? []) {
    if (/^\**$/.test(glob)) add(at, `'${glob}' matches every tool`);
  }
}

function uniqueIds(ids: string[], at: string, add: (path: string, message: string) => void): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) add(at, `duplicate id '${id}'`);
    seen.add(id);
  }
}

function mergeRuleLists(
  ...layers: Array<{ allow?: string[]; ask?: string[]; confirm?: string[]; deny?: string[] }>
): { allow: string[]; ask: string[]; confirm: string[]; deny: string[] } {
  return {
    allow: layers.flatMap((l) => l.allow ?? []),
    ask: layers.flatMap((l) => l.ask ?? []),
    confirm: layers.flatMap((l) => l.confirm ?? []),
    deny: layers.flatMap((l) => l.deny ?? []),
  };
}

// -----------------------------------------------------------------------------
// Loading
// -----------------------------------------------------------------------------

export function resolveBundledIntegrationCatalogPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "..", "registry", "integrations.json"),
    resolve(here, "..", "..", "registry", "integrations.json"),
    resolve(here, "..", "registry", "integrations.json"),
    resolve(process.cwd(), "registry", "integrations.json"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** Parse and schema-check integrations.json, then run the cross-catalog
 *  rules against `ctx` when given. */
export function parseIntegrationCatalogText(text: string, ctx?: CatalogValidationContext): IntegrationCatalog {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new IntegrationCatalogError(
      `registry/integrations.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = IntegrationCatalogSchema.safeParse(raw);
  if (!parsed.success) {
    throw new IntegrationCatalogError(
      "registry/integrations.json failed schema validation",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  if (ctx) {
    const issues = validateIntegrationCatalog(parsed.data, ctx);
    if (issues.length > 0) {
      throw new IntegrationCatalogError("registry/integrations.json failed cross-catalog validation", issues);
    }
  }
  return parsed.data;
}

export function loadBundledIntegrationCatalog(ctx?: CatalogValidationContext): IntegrationCatalog {
  const path = resolveBundledIntegrationCatalogPath();
  if (!path) throw new IntegrationCatalogError("bundled registry/integrations.json not found");
  return parseIntegrationCatalogText(readFileSync(path, "utf-8"), ctx);
}

// -----------------------------------------------------------------------------
// Lookups
// -----------------------------------------------------------------------------

/** By id or alias, case-insensitively. */
export function findIntegration(catalog: IntegrationCatalog, idOrAlias: string): IntegrationEntry | null {
  const key = idOrAlias.trim().toLowerCase();
  return (
    catalog.integrations.find((e) => e.id === key) ??
    catalog.integrations.find((e) => e.aliases.includes(key)) ??
    null
  );
}

export function findVariant(entry: IntegrationEntry, variantId?: string): IntegrationVariant | null {
  if (variantId === undefined) return recommendedVariant(entry);
  return entry.variants.find((v) => v.id === variantId) ?? null;
}

export function recommendedVariant(entry: IntegrationEntry): IntegrationVariant {
  return entry.variants.find((v) => v.recommended) ?? entry.variants[0]!;
}

export function accessLevelSpec(variant: IntegrationVariant, level: AccessLevelId): IntegrationAccessLevel | null {
  return variant.access_levels[level] ?? null;
}

/** Secret slots a variant stores (secret names as the catalog declares them). */
export function variantSecretSlots(variant: IntegrationVariant): string[] {
  switch (variant.auth.kind) {
    case "secrets":
      return variant.auth.fields.map((f) => f.secret);
    case "basic":
      return [variant.auth.secret];
    default:
      return [];
  }
}
