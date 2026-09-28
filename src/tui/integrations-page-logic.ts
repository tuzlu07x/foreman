import type { IntegrationCatalog, IntegrationEntry, IntegrationVariant } from "../core/integrations/catalog.js";
import type { ToolOverrideChoice } from "../core/integrations/render.js";
import type { AccessChoice } from "../core/integrations/service.js";
import type { IntegrationStatus } from "../core/integrations/status.js";
import type { McpCatalog } from "../core/mcp-hub/catalog.js";
import { findCatalogEntry } from "../core/mcp-hub/catalog.js";
import { referencedSecrets, type HubConfig, type ServerConfig } from "../core/mcp-hub/config.js";

// Pure state for the TUI Integrations page (integrations-page.tsx): rows,
// the add flow's steps, the tool-rule cycle and what a removal takes away.

export interface ConfiguredRow {
  kind: "configured";
  name: string;
  server: ServerConfig;
  entry: IntegrationEntry | null;
  variant: IntegrationVariant | null;
  status: IntegrationStatus;
}

export interface AvailableRow {
  kind: "available";
  entry: IntegrationEntry;
}

export type IntegrationRow = ConfiguredRow | AvailableRow;

/** Configured integrations first (by name), then catalog entries nobody
 *  has added yet. */
export function buildIntegrationRows(
  config: HubConfig,
  catalog: IntegrationCatalog,
  status: (name: string) => IntegrationStatus,
): IntegrationRow[] {
  const configured: ConfiguredRow[] = Object.entries(config.servers)
    .filter(([, s]) => s.integration)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, server]) => {
      const entry = catalog.integrations.find((e) => e.id === server.integration!.id) ?? null;
      const variant = entry?.variants.find((v) => v.id === server.integration!.variant) ?? null;
      return { kind: "configured", name, server, entry, variant, status: status(name) };
    });
  const used = new Set(configured.map((r) => r.server.integration!.id));
  const available: AvailableRow[] = catalog.integrations
    .filter((e) => !used.has(e.id))
    .map((entry) => ({ kind: "available", entry }));
  return [...configured, ...available];
}

/** `official · token · read-write · 41 tools · 3 ask` */
export function rowSummary(row: ConfiguredRow): string {
  const meta = row.server.integration!;
  const auth = authShort(row.variant);
  const parts = [meta.variant, ...(auth !== meta.variant ? [auth] : []), meta.access_level];
  const t = row.status.tools;
  parts.push(t ? `${t.total} tools · ${t.ask + t.confirm} ask` : "not reviewed");
  return parts.filter((p) => p.length > 0).join(" · ");
}

export function authShort(variant: IntegrationVariant | null): string {
  switch (variant?.auth.kind) {
    case "oauth":
      return "sign-in";
    case "basic":
      return "user + token";
    case "secrets":
      return variant.auth.fields.length > 1 ? "keys" : "token";
    default:
      return "";
  }
}

// -----------------------------------------------------------------------------
// Add flow
// -----------------------------------------------------------------------------

export type AddStep = "variant" | "params" | "level" | "who" | "credentials";

/** The steps adding this variant needs, in order. The variant step only
 *  shows when there is more than one; credentials only for token kinds
 *  (OAuth signs in after saving). */
export function addSteps(entry: IntegrationEntry, variant: IntegrationVariant | null, mcp: McpCatalog): AddStep[] {
  const steps: AddStep[] = [];
  if (entry.variants.length > 1) steps.push("variant");
  const server = variant ? findCatalogEntry(mcp, variant.server) : null;
  if (!variant || (server?.user_params.length ?? 0) > 0) steps.push("params");
  steps.push("level", "who");
  if (!variant || variant.auth.kind === "secrets" || variant.auth.kind === "basic") steps.push("credentials");
  return steps;
}

/** The variant list: recommended first, then catalog order. */
export function orderedVariants(entry: IntegrationEntry): IntegrationVariant[] {
  return [...entry.variants].sort((a, b) => Number(b.recommended) - Number(a.recommended));
}

export const EVERYONE = "__everyone__";
const DEPARTMENT_PREFIX = "dept:";

export function departmentOption(id: string): string {
  return `${DEPARTMENT_PREFIX}${id}`;
}

/** MultiSelect values → an access choice. Nothing picked = nobody, which
 *  the caller refuses; "everyone" wins over any other pick. */
export function accessFromSelection(values: readonly string[]): AccessChoice | null {
  if (values.includes(EVERYONE)) return "all";
  const agents = values.filter((v) => !v.startsWith(DEPARTMENT_PREFIX) && v !== EVERYONE);
  const departments = values.filter((v) => v.startsWith(DEPARTMENT_PREFIX)).map((v) => v.slice(DEPARTMENT_PREFIX.length));
  if (agents.length === 0 && departments.length === 0) return null;
  return {
    ...(agents.length > 0 ? { agents } : {}),
    ...(departments.length > 0 ? { departments } : {}),
  };
}

/** Pre-selected agents: the catalog's suggestions that are registered,
 *  else every registered agent. */
export function suggestedAgents(entry: IntegrationEntry, registered: readonly string[]): string[] {
  const suggested = entry.used_by_agents.filter((a) => registered.includes(a));
  return suggested.length > 0 ? suggested : [...registered];
}

// -----------------------------------------------------------------------------
// Tool rules
// -----------------------------------------------------------------------------

export const TOOL_RULE_CYCLE: readonly ToolOverrideChoice[] = ["default", "allow", "ask", "confirm", "deny"];

export function cycleToolRule(current: ToolOverrideChoice, direction: 1 | -1): ToolOverrideChoice {
  const i = TOOL_RULE_CYCLE.indexOf(current);
  const n = TOOL_RULE_CYCLE.length;
  return TOOL_RULE_CYCLE[(((i < 0 ? 0 : i) + direction) % n + n) % n]!;
}

/** The override a tool has now (`default` when none names it exactly). */
export function currentOverride(server: ServerConfig, tool: string): ToolOverrideChoice {
  const rules = server.integration?.tool_overrides ?? {};
  for (const key of ["deny", "confirm", "ask", "allow"] as const) {
    if ((rules[key] ?? []).includes(tool)) return key;
  }
  return "default";
}

// -----------------------------------------------------------------------------
// Removal
// -----------------------------------------------------------------------------

export interface RemovalPlan {
  /** Secrets deleted from the store (no other server uses them). */
  deletes: string[];
  /** Secrets another server still uses (always kept). */
  shared: string[];
  signsOut: boolean;
  revokeUrl: string | null;
}

export function removalPlan(config: HubConfig, name: string, variant: IntegrationVariant | null): RemovalPlan {
  const server = config.servers[name]!;
  const others = new Set(
    Object.entries(config.servers)
      .filter(([n]) => n !== name)
      .flatMap(([, s]) => referencedSecrets(s)),
  );
  const secrets = referencedSecrets(server);
  return {
    deletes: secrets.filter((s) => !others.has(s)),
    shared: secrets.filter((s) => others.has(s)),
    signsOut: server.auth === "oauth",
    revokeUrl: variant?.revoke_url ?? null,
  };
}
