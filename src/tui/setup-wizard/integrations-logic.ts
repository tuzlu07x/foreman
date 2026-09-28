import {
  recommendedVariant,
  type IntegrationCatalog,
  type IntegrationEntry,
  type IntegrationVariant,
} from "../../core/integrations/catalog.js";
import type { AccessChoice, AddIntegrationInput } from "../../core/integrations/service.js";
import { findCatalogEntry, type McpCatalog } from "../../core/mcp-hub/catalog.js";
import type { AccessLevelId, HubConfig } from "../../core/mcp-hub/config.js";

// =============================================================================
// Setup wizard — Integrations step (pure logic)
// =============================================================================
//
// The optional step between Services and Install (docs/plans/integrations.md
// §7). The user ticks integrations; for each one the wizard takes the
// catalog's recommended variant, asks for the access level (read-only by
// default) and, for token variants, the credentials. OAuth variants are not
// signed in here: the wizard never opens a browser for an integration, the
// Done screen names `foreman integrations login <name>` instead. Every
// integration is saved disabled; nothing in this step touches the network.

export type IntegrationsPhase = "picker" | "configure" | "saving" | "summary";

/** One screen of the per-integration flow, in order. */
export type IntegrationStage = "params" | "level" | "credentials";

/** One credential prompt. `basic` variants ask for a user name, then the
 *  password; the service stores base64(user:password) as one secret. */
export interface CredentialField {
  kind: "secret" | "username" | "password";
  /** Secret store name (the variant's slot). */
  secret: string;
  label: string;
  formatHint: string | null;
  whereToGet: string | null;
  setupSteps: string[];
  pattern: string | null;
}

/** What the user has entered so far for the integration being configured.
 *  Credential values live here only until the integration is saved. */
export interface IntegrationDraft {
  stage: IntegrationStage;
  paramIdx: number;
  params: Record<string, string>;
  accessLevel: AccessLevelId;
  credIdx: number;
  /** Slot → new value (typed in this run). */
  credentials: Record<string, string>;
  username: string | null;
  /** Slots whose stored value the user chose to keep. */
  keep: string[];
  /** Bumped on a refused credential, so its (masked) field starts empty. */
  attempt: number;
}

export type IntegrationOutcome = "saved" | "skipped" | "failed";

export interface IntegrationResult {
  id: string;
  name: string;
  /** mcp.yaml server name, when saved. */
  server: string | null;
  outcome: IntegrationOutcome;
  oauth: boolean;
  detail: string | null;
}

/** Integration ids already in mcp.yaml: as an integration, or as a plain
 *  server with the same name (which `foreman integrations adopt` turns
 *  into one). The picker leaves them out — adding again would collide. */
export function configuredIntegrationIds(config: HubConfig, catalog: IntegrationCatalog): string[] {
  const ids = new Set<string>();
  for (const [name, server] of Object.entries(config.servers)) {
    if (server.integration) ids.add(server.integration.id);
    else if (catalog.integrations.some((e) => e.id === name)) ids.add(name);
  }
  return catalog.integrations.filter((e) => ids.has(e.id)).map((e) => e.id);
}

/** `token`, `browser sign-in`, … for the recommended variant. */
export function authLabel(variant: IntegrationVariant): string {
  switch (variant.auth.kind) {
    case "oauth":
      return "browser sign-in, after setup";
    case "basic":
      return "user name + token";
    case "secrets":
      return variant.auth.fields.length > 1 ? "keys" : "token";
    default:
      return "no credentials";
  }
}

export interface PickerOption {
  value: string;
  label: string;
}

/** The picker: every catalog integration not configured yet, labelled with
 *  how it signs in. */
export function integrationPickerOptions(
  catalog: IntegrationCatalog,
  configured: readonly string[],
): PickerOption[] {
  return catalog.integrations
    .filter((e) => !configured.includes(e.id))
    .map((e) => ({ value: e.id, label: `${e.name} — ${authLabel(recommendedVariant(e))}` }));
}

/** Empty + Enter skips the step (nothing to configure); otherwise the
 *  picks are configured in order. `selected` accumulates every id picked
 *  in this setup, for the Done screen. */
export function applyIntegrationsPickerSubmit(
  values: readonly string[],
  alreadySelected: readonly string[],
): { kind: "skip" } | { kind: "configure"; queue: string[]; selected: string[] } {
  if (values.length === 0) return { kind: "skip" };
  return {
    kind: "configure",
    queue: [...values],
    selected: [...alreadySelected, ...values.filter((v) => !alreadySelected.includes(v))],
  };
}

/** The screens this variant needs: params (only when the server declares
 *  any), the access level, then credentials for token variants. */
export function integrationStages(variant: IntegrationVariant, mcp: McpCatalog): IntegrationStage[] {
  const stages: IntegrationStage[] = [];
  if ((findCatalogEntry(mcp, variant.server)?.user_params.length ?? 0) > 0) stages.push("params");
  stages.push("level");
  if (variant.auth.kind === "secrets" || variant.auth.kind === "basic") stages.push("credentials");
  return stages;
}

export function freshDraft(variant: IntegrationVariant, mcp: McpCatalog): IntegrationDraft {
  return {
    stage: integrationStages(variant, mcp)[0]!,
    paramIdx: 0,
    params: {},
    // §13.5: new integrations default to read-only in the wizard.
    accessLevel: "read-only",
    credIdx: 0,
    credentials: {},
    username: null,
    keep: [],
    attempt: 0,
  };
}

/** Why a typed parameter (e.g. the GitLab host) is refused, or null. */
export function paramProblem(spec: { label: string; pattern: string; example: string }, value: string): string | null {
  const re = new RegExp(spec.pattern);
  if (value.length === 0 || value.length > 200 || !(re.test(value) || re.test(value.toLowerCase()))) {
    return `${spec.label} doesn't look right (e.g. ${spec.example})`;
  }
  return null;
}

/** The stage after `stage`, or null when the draft is ready to save. */
export function nextStage(
  variant: IntegrationVariant,
  mcp: McpCatalog,
  stage: IntegrationStage,
): IntegrationStage | null {
  const stages = integrationStages(variant, mcp);
  return stages[stages.indexOf(stage) + 1] ?? null;
}

export function credentialFields(variant: IntegrationVariant, mcp: McpCatalog): CredentialField[] {
  const auth = variant.auth;
  const server = findCatalogEntry(mcp, variant.server);
  const serverPattern = (slot: string): string | null =>
    server?.secrets.find((s) => s.name === slot)?.pattern ?? null;
  if (auth.kind === "secrets") {
    return auth.fields.map((f) => ({
      kind: "secret",
      secret: f.secret,
      label: f.label,
      formatHint: f.format_hint,
      whereToGet: f.where_to_get,
      setupSteps: f.setup_steps,
      pattern: f.pattern ?? serverPattern(f.secret),
    }));
  }
  if (auth.kind === "basic") {
    return [
      {
        kind: "username",
        secret: auth.secret,
        label: auth.username_label,
        formatHint: null,
        whereToGet: null,
        setupSteps: [],
        pattern: null,
      },
      {
        kind: "password",
        secret: auth.secret,
        label: auth.password_label,
        formatHint: auth.format_hint,
        whereToGet: auth.where_to_get,
        setupSteps: auth.setup_steps,
        pattern: null,
      },
    ];
  }
  return [];
}

/** Why a typed credential is refused, or null. Never echoes the value. */
export function credentialProblem(field: CredentialField, value: string): string | null {
  if (field.kind === "username") {
    return value.includes(":") ? "a user name can't contain ':'" : null;
  }
  if (value.length > 8192 || /[\r\n\u0000]/.test(value)) {
    return `that ${field.label} is too long or has line breaks`;
  }
  if (field.pattern && !new RegExp(field.pattern).test(value)) {
    return `that doesn't look like a ${field.label}${field.formatHint ? ` (${field.formatHint})` : ""}`;
  }
  return null;
}

export type CredentialSubmit =
  /** Stored value kept (empty Enter while one exists): the rest of a
   *  basic pair is not asked. */
  | { kind: "keep"; draft: IntegrationDraft; done: boolean }
  /** Empty Enter with nothing stored: leave this integration out. */
  | { kind: "skip" }
  | { kind: "invalid"; problem: string }
  | { kind: "next"; draft: IntegrationDraft; done: boolean };

/** One credential prompt's Enter. `stored` = the slot already has a value
 *  in the secret store (e.g. github-pat from the Services step of an older
 *  Foreman). */
export function applyCredentialSubmit(
  draft: IntegrationDraft,
  fields: readonly CredentialField[],
  raw: string,
  stored: boolean,
): CredentialSubmit {
  const field = fields[draft.credIdx];
  if (!field) return { kind: "next", draft, done: true };
  const value = raw.trim();
  const last = draft.credIdx + 1 >= fields.length;
  if (value.length === 0) {
    if (!stored) return { kind: "skip" };
    const keep = draft.keep.includes(field.secret) ? draft.keep : [...draft.keep, field.secret];
    // A basic pair is one secret: keeping it skips the password prompt.
    const done = last || field.kind === "username";
    return { kind: "keep", draft: { ...draft, keep, credIdx: draft.credIdx + 1 }, done };
  }
  const problem = credentialProblem(field, value);
  if (problem) return { kind: "invalid", problem };
  const next: IntegrationDraft =
    field.kind === "username"
      ? { ...draft, username: value, credIdx: draft.credIdx + 1 }
      : { ...draft, credentials: { ...draft.credentials, [field.secret]: value }, credIdx: draft.credIdx + 1 };
  return { kind: "next", draft: next, done: last };
}

/** Access for a wizard-added integration: the agents picked earlier in
 *  the wizard, else every verified agent. */
export function wizardAccess(agentsSelected: readonly string[]): AccessChoice {
  return agentsSelected.length > 0 ? { agents: [...agentsSelected] } : "all";
}

export function describeWizardAccess(access: AccessChoice): string {
  if (access === "all") return "every verified agent";
  return (access.agents ?? []).join(", ");
}

/** What IntegrationService.add gets, plus the credentials that replace a
 *  stored value (add refuses to overwrite a secret, so those are rotated
 *  after the add). Always saved disabled — add never enables. */
export function buildWizardAddInput(
  entry: IntegrationEntry,
  variant: IntegrationVariant,
  draft: IntegrationDraft,
  access: AccessChoice,
  stored: (secret: string) => boolean,
): { input: AddIntegrationInput; rotate: Record<string, string> } {
  const credentials: Record<string, string> = {};
  const rotate: Record<string, string> = {};
  for (const [slot, value] of Object.entries(draft.credentials)) {
    if (variant.auth.kind === "basic") continue;
    if (stored(slot)) rotate[slot] = value;
    else credentials[slot] = value;
  }
  const input: AddIntegrationInput = {
    id: entry.id,
    variant: variant.id,
    accessLevel: draft.accessLevel,
    access,
    ...(Object.keys(draft.params).length > 0 ? { params: { ...draft.params } } : {}),
    ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
  };
  const password = variant.auth.kind === "basic" ? draft.credentials[variant.auth.secret] : undefined;
  if (variant.auth.kind === "basic" && draft.username !== null && password) {
    const basic = Buffer.from(`${draft.username}:${password}`, "utf-8").toString("base64");
    if (stored(variant.auth.secret)) rotate[variant.auth.secret] = basic;
    else input.basicAuth = { username: draft.username, password };
  }
  return { input, rotate };
}

/** The Done screen's next command for a saved (disabled) integration. */
export function nextCommand(name: string, oauth: boolean): string {
  return oauth ? `foreman integrations login ${name}` : `foreman integrations review ${name}`;
}

export interface PendingIntegration {
  name: string;
  label: string;
  oauth: boolean;
  command: string;
}

/** Integrations this wizard added that are still off, with what to run
 *  next. Read from mcp.yaml, so a resumed run lists them too. */
export function pendingIntegrations(
  config: HubConfig,
  catalog: IntegrationCatalog,
  ids: readonly string[],
): PendingIntegration[] {
  return Object.entries(config.servers)
    .filter(([, s]) => s.integration && ids.includes(s.integration.id) && !s.enabled)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, s]) => {
      const oauth = s.auth === "oauth";
      const label = catalog.integrations.find((e) => e.id === s.integration!.id)?.name ?? name;
      return { name, label, oauth, command: nextCommand(name, oauth) };
    });
}
