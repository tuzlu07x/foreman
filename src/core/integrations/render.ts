import { redactSecretShapes } from "../risk-rules/secret-patterns.js";
import { isReservedSecretName } from "../secret-store.js";
import { resolveCatalogParams, serverConfigFromCatalog, type McpCatalogEntry } from "../mcp-hub/catalog.js";
import {
  isMcpOAuthSecretName,
  SECRET_NAME_RE,
  toolRuleLevel,
  type AccessLevelId,
  type ServerConfigInput,
  type ToolRuleLevel,
  type ToolRules,
} from "../mcp-hub/config.js";
import type { IntegrationEntry, IntegrationVariant } from "./catalog.js";

// =============================================================================
// Render an integration into its mcp.yaml server block
// =============================================================================
//
// The block is always derived, never edited in place: catalog server
// (with params and secret names filled in) + the access level's headers /
// env + tool rules from four layers — the catalog server, the access level,
// denies for products left out, and the user's per-tool overrides. The
// layers are unioned and evaluated deny > confirm > ask > allow, so an
// override can tighten anything but can never lift a deny or a confirm the
// catalog or the access level set.

export class IntegrationRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationRenderError";
  }
}

export interface RenderIntegrationInput {
  entry: IntegrationEntry;
  variant: IntegrationVariant;
  /** The catalog server `variant.server` names. */
  server: McpCatalogEntry;
  accessLevel: AccessLevelId;
  /** Selected product ids; absent = all. */
  products?: readonly string[] | undefined;
  params?: Readonly<Record<string, string>>;
  /** Secret slot (catalog name) → secret-store name, for a second account. */
  secretNames?: Readonly<Record<string, string>>;
  toolOverrides?: ToolRules;
}

export interface IgnoredOverride {
  tool: string;
  wanted: ToolRuleLevel;
  effective: ToolRuleLevel;
}

export interface RenderedIntegration {
  /** Launch config and tool rules; the caller adds enabled / access / integration. */
  server: Omit<ServerConfigInput, "enabled" | "access" | "integration">;
  /** Every parameter's value, defaults included. */
  params: Record<string, string>;
  /** Every secret slot → the store name the block references. */
  secrets: Record<string, string>;
  /** Normalised selection: undefined when every product is selected. */
  products: string[] | undefined;
  /** Overrides a stronger rule shadows (they have no effect). */
  ignoredOverrides: IgnoredOverride[];
}

const SECRET_REF_RE = /\$\{secret:([A-Za-z0-9][A-Za-z0-9._-]{0,127})\}/g;

export function renderIntegration(input: RenderIntegrationInput): RenderedIntegration {
  const { entry, variant, server, accessLevel } = input;
  if (variant.server !== server.id) {
    throw new IntegrationRenderError(`variant '${variant.id}' uses server '${variant.server}', not '${server.id}'`);
  }
  const level = variant.access_levels[accessLevel];
  if (!level) {
    throw new IntegrationRenderError(`${entry.name} (${variant.label}) has no ${accessLevel} access level`);
  }
  const products = normaliseProducts(entry, input.products);
  const secrets = secretNameMap(server, input.secretNames ?? {});
  const params = resolveCatalogParams(server, input.params ?? {});
  const base = serverConfigFromCatalog(server, [], params);

  const rename = (value: string): string =>
    value.replace(SECRET_REF_RE, (_m, slot: string) => `\${secret:${secrets[slot] ?? slot}}`);
  const rendered: RenderedIntegration["server"] = { catalog_id: server.id };
  if (base.url !== undefined) {
    rendered.url = rename(base.url);
    rendered.headers = mapRecord({ ...(base.headers ?? {}), ...level.headers }, rename);
  } else {
    rendered.command = base.command!;
    rendered.args = (base.args ?? []).map(rename);
    rendered.env = mapRecord({ ...(base.env ?? {}), ...level.env }, rename);
  }
  if (base.auth) rendered.auth = base.auth;

  const layers: ToolRules[] = [base.tools ?? {}, level.tools];
  if (products) {
    const left = entry.products.filter((p) => !products.includes(p.id));
    layers.push({ deny: [...left.flatMap((p) => p.tools), ...entry.cross_product_tools] });
  }
  const catalogRules = mergeToolRules(...layers);
  const overrides = normaliseToolRules(input.toolOverrides ?? {});
  rendered.tools = mergeToolRules(catalogRules, overrides);

  assertNoLiteralCredentials(rendered);
  return {
    server: rendered,
    params,
    secrets,
    products,
    ignoredOverrides: shadowedOverrides(catalogRules, overrides),
  };
}

// -----------------------------------------------------------------------------
// Tool rules
// -----------------------------------------------------------------------------

const RULE_KEYS = ["allow", "ask", "confirm", "deny"] as const;

/** Union of every layer's lists, de-duplicated, empty lists dropped. */
export function mergeToolRules(...layers: ToolRules[]): ToolRules {
  const out: ToolRules = {};
  for (const key of RULE_KEYS) {
    const seen = new Set<string>();
    for (const layer of layers) for (const glob of layer[key] ?? []) seen.add(glob);
    if (seen.size > 0) out[key] = [...seen];
  }
  return out;
}

export function normaliseToolRules(rules: ToolRules): ToolRules {
  return mergeToolRules(rules);
}

export type ToolOverrideChoice = ToolRuleLevel | "default";

/** Set one tool's override (upstream tool name), or clear it with `default`. */
export function applyToolOverride(overrides: ToolRules, tool: string, choice: ToolOverrideChoice): ToolRules {
  const name = tool.trim();
  if (name.length === 0 || name.length > 200 || /[\s*]/.test(name)) {
    throw new IntegrationRenderError(`'${tool}' is not a tool name`);
  }
  const out: ToolRules = {};
  for (const key of RULE_KEYS) {
    const list = (overrides[key] ?? []).filter((g) => g !== name);
    if (key === choice) list.push(name);
    if (list.length > 0) out[key] = list;
  }
  return out;
}

/** Overrides naming a single tool that a stronger catalog / access-level
 *  rule outranks. */
function shadowedOverrides(catalogRules: ToolRules, overrides: ToolRules): IgnoredOverride[] {
  const merged = mergeToolRules(catalogRules, overrides);
  const out: IgnoredOverride[] = [];
  for (const wanted of RULE_KEYS) {
    for (const tool of overrides[wanted] ?? []) {
      if (tool.includes("*")) continue;
      const effective = toolRuleLevel(merged, tool);
      if (effective !== null && effective !== wanted) out.push({ tool, wanted, effective });
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function normaliseProducts(entry: IntegrationEntry, selected: readonly string[] | undefined): string[] | undefined {
  if (selected === undefined) return undefined;
  if (entry.products.length === 0) {
    if (selected.length === 0) return undefined;
    throw new IntegrationRenderError(`${entry.name} has no separate products`);
  }
  const known = new Set(entry.products.map((p) => p.id));
  const unique = [...new Set(selected.map((p) => p.trim().toLowerCase()))];
  for (const id of unique) {
    if (!known.has(id)) {
      throw new IntegrationRenderError(`${entry.name} has no product '${id}' (products: ${[...known].join(", ")})`);
    }
  }
  if (unique.length === 0) throw new IntegrationRenderError(`select at least one ${entry.name} product`);
  if (unique.length === known.size) return undefined;
  return entry.products.map((p) => p.id).filter((id) => unique.includes(id));
}

function secretNameMap(server: McpCatalogEntry, names: Readonly<Record<string, string>>): Record<string, string> {
  const slots = new Set(server.secrets.map((s) => s.name));
  for (const slot of Object.keys(names)) {
    if (!slots.has(slot)) throw new IntegrationRenderError(`'${server.id}' has no secret '${slot}'`);
  }
  const out: Record<string, string> = {};
  for (const slot of slots) {
    const name = names[slot] ?? slot;
    if (!SECRET_NAME_RE.test(name) || isMcpOAuthSecretName(name) || isReservedSecretName(name)) {
      throw new IntegrationRenderError(`'${name}' cannot hold an integration secret`);
    }
    out[slot] = name;
  }
  return out;
}

/** A header, env value or arg that looks like a raw credential (rather
 *  than a `${secret:…}` reference) is refused: it would sit in mcp.yaml in
 *  plain text. */
function assertNoLiteralCredentials(server: RenderedIntegration["server"]): void {
  const values = [
    ...Object.entries(server.headers ?? {}),
    ...Object.entries(server.env ?? {}),
    ...(server.args ?? []).map((a, i) => [`args[${i}]`, a] as const),
    ...(server.url ? [["url", server.url] as const] : []),
  ];
  for (const [key, value] of values) {
    const withoutRefs = value.replace(SECRET_REF_RE, "");
    if (redactSecretShapes(withoutRefs).count > 0) {
      throw new IntegrationRenderError(
        `'${key}' holds what looks like a credential; store it with the secret store and reference it as \${secret:<name>}`,
      );
    }
  }
}

function mapRecord(input: Record<string, string>, fn: (v: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) out[k] = fn(v);
  return out;
}
