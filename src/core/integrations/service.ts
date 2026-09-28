import { findCatalogEntry, type McpCatalog, type McpCatalogEntry } from "../mcp-hub/catalog.js";
import {
  loadHubConfig,
  referencedSecrets,
  updateHubConfig,
  type AccessLevelId,
  type HubConfig,
  type IntegrationMeta,
  type ServerAccess,
  type ServerConfig,
  type ServerConfigInput,
  type ToolRules,
} from "../mcp-hub/config.js";
import type { ToolPinStore } from "../mcp-hub/pins.js";
import type { SecretStore } from "../secret-store.js";
import {
  findIntegration,
  findVariant,
  NOTIFY_SECRET_NAMES,
  variantSecretSlots,
  type IntegrationCatalog,
  type IntegrationEntry,
  type IntegrationVariant,
} from "./catalog.js";
import {
  applyToolOverride,
  renderIntegration,
  type IgnoredOverride,
  type ToolOverrideChoice,
} from "./render.js";
import { resolveIntegration } from "./resolve.js";
import { blockingProblems, integrationStatus, launchFingerprint, type IntegrationStatus } from "./status.js";

// =============================================================================
// IntegrationService — every change to an integration goes through here
// =============================================================================
//
// The CLI, the TUI, the setup wizard and chat all call this class, so the
// rules live in one place:
//
// - The mcp.yaml block is re-rendered from the catalog on every change
//   (render.ts), under the mcp.yaml lock (updateHubConfig).
// - Credentials go to the encrypted secret store. mcp.yaml, errors and the
//   audit log only ever carry secret NAMES.
// - A new integration is always saved disabled: its tools are reviewed and
//   pinned, then enable() checks it is ready, before any agent can call it.
// - A change to what the hub launches (variant, params) forgets the pins
//   and disables the integration, so a new server is never trusted on
//   first use.
// - A failed add rolls back the secrets it stored.

export type IntegrationVia = "cli" | "tui" | "wizard" | "slack" | "discord" | "telegram";

export interface IntegrationActor {
  via: IntegrationVia;
  /** Who, where the surface knows it (a Slack user id, "tui"). */
  actor?: string;
}

/** Who may use the integration: `"all"` = every verified agent. There is
 *  no default: a new integration always needs an explicit choice. */
export type AccessChoice = ServerAccess | "all";

export interface AddIntegrationInput {
  /** Integration id or alias from registry/integrations.json. */
  id: string;
  /** Variant id; the recommended one when absent. */
  variant?: string;
  /** mcp.yaml server name; the integration id when absent. A second
   *  account is a second server (github-work). */
  name?: string;
  accessLevel?: AccessLevelId;
  access: AccessChoice;
  params?: Readonly<Record<string, string>>;
  products?: readonly string[];
  /** Secret slot → store name (defaults to the slot's own name). */
  secretNames?: Readonly<Record<string, string>>;
  /** Secret slot → value. Stored encrypted; never logged. A slot without
   *  a value reuses a secret already in the store. */
  credentials?: Readonly<Record<string, string>>;
  /** For `basic` variants: stored as base64(username:password). */
  basicAuth?: { username: string; password: string };
  toolOverrides?: ToolRules;
}

export interface UpdateIntegrationInput {
  variant?: string;
  accessLevel?: AccessLevelId;
  access?: AccessChoice;
  params?: Readonly<Record<string, string>>;
  /** `null` selects every product again. */
  products?: readonly string[] | null;
  toolOverride?: { tool: string; choice: ToolOverrideChoice };
}

export interface IntegrationChangeResult {
  name: string;
  server: ServerConfig;
  /** Overrides a stronger catalog rule shadows (they have no effect). */
  ignoredOverrides: IgnoredOverride[];
  /** The launch configuration changed: pins were forgotten and the
   *  integration was disabled until it is reviewed again. */
  needsReview: boolean;
}

export interface RemoveIntegrationResult {
  name: string;
  /** Secrets deleted from the store. */
  removedSecrets: string[];
  /** Secrets kept: another server uses them, or keepSecrets was set. */
  keptSecrets: string[];
  oauthSessionRemoved: boolean;
  /** Where to revoke Foreman's access at the provider. */
  revokeUrl: string | null;
}

export class IntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationError";
  }
}

/** Enabling was refused: the integration is not ready (login, secrets,
 *  review). */
export class IntegrationNotReadyError extends IntegrationError {
  constructor(
    name: string,
    public readonly status: IntegrationStatus,
  ) {
    super(`${name} is not ready: ${blockingProblems(status).map((p) => p.detail).join("; ")}`);
    this.name = "IntegrationNotReadyError";
  }
}

export interface IntegrationAuditSink {
  logEvent(eventType: string, payload: unknown): void;
}

export interface IntegrationServiceDeps {
  paths: { mcpConfigPath: string };
  mcpCatalog: McpCatalog;
  integrationCatalog: IntegrationCatalog;
  secrets: Pick<SecretStore, "add" | "rotate" | "remove" | "exists" | "get">;
  pins: Pick<ToolPinStore, "get" | "forget">;
  audit: IntegrationAuditSink;
  /** Drops the hub OAuth session (and revokes it where the provider can).
   *  Returns whether there was one. */
  removeOAuthSession?: (server: string) => Promise<boolean>;
  now?: () => Date;
}

export class IntegrationService {
  constructor(private readonly deps: IntegrationServiceDeps) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  config(): HubConfig {
    return loadHubConfig(this.deps.paths.mcpConfigPath);
  }

  status(query: string, config: HubConfig = this.config()): IntegrationStatus {
    // Resolve ids and aliases (gh → github): the status names the server.
    const { name, server } = this.require(config, query);
    return integrationStatus(name, server, {
      pins: this.deps.pins,
      secrets: this.deps.secrets,
      security: config.security,
    });
  }


  // ---------------------------------------------------------------------------
  // Add
  // ---------------------------------------------------------------------------

  async add(input: AddIntegrationInput, actor: IntegrationActor): Promise<IntegrationChangeResult> {
    const entry = this.entry(input.id);
    const variant = this.variant(entry, input.variant);
    const server = this.catalogServer(variant);
    const name = (input.name ?? entry.id).trim().toLowerCase();
    const accessLevel = input.accessLevel ?? variant.default_access_level;
    const now = this.now();

    const rendered = this.render(entry, variant, server, {
      accessLevel,
      products: input.products,
      params: input.params,
      secretNames: input.secretNames,
      toolOverrides: input.toolOverrides,
    });
    const values = this.credentialValues(variant, server, input);
    for (const slot of Object.keys(values)) {
      const store = rendered.secrets[slot]!;
      if (this.deps.secrets.exists(store)) {
        throw new IntegrationError(
          `secret '${store}' already exists — leave it out to reuse it, rotate it, or store this one under another name`,
        );
      }
    }

    const meta: IntegrationMeta = {
      id: entry.id,
      variant: variant.id,
      access_level: accessLevel,
      ...(rendered.products ? { products: rendered.products } : {}),
      params: rendered.params,
      secrets: rendered.secrets,
      tool_overrides: input.toolOverrides ?? {},
      created_at: now,
      updated_at: now,
    };
    const block: ServerConfigInput = {
      ...rendered.server,
      enabled: false,
      ...accessBlock(input.access),
      integration: meta,
    };

    const stored: string[] = [];
    try {
      for (const [slot, value] of Object.entries(values)) {
        const store = rendered.secrets[slot]!;
        this.deps.secrets.add(store, value);
        stored.push(store);
      }
      const { after } = await updateHubConfig(this.deps.paths, (current) => {
        if (Object.hasOwn(current.servers, name)) {
          throw new IntegrationError(
            `a server named '${name}' already exists — pick another name (e.g. ${entry.id}-work)`,
          );
        }
        return { ...current, servers: { ...current.servers, [name]: block as ServerConfig } };
      });
      this.audit("integration:added", actor, {
        integration: entry.id,
        server: name,
        variant: variant.id,
        access_level: accessLevel,
        access: describeAccessChoice(input.access),
        products: rendered.products ?? "all",
        secrets: Object.values(rendered.secrets),
        stored_secrets: stored,
      });
      return {
        name,
        server: after.servers[name]!,
        ignoredOverrides: rendered.ignoredOverrides,
        needsReview: false,
      };
    } catch (err) {
      for (const store of stored) {
        try {
          this.deps.secrets.remove(store);
        } catch {
          // best-effort rollback
        }
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------

  async update(
    query: string,
    changes: UpdateIntegrationInput,
    actor: IntegrationActor,
  ): Promise<IntegrationChangeResult> {
    let result: IntegrationChangeResult | null = null;
    let changed: string[] = [];
    await updateHubConfig(this.deps.paths, (current) => {
      const { name, server } = this.require(current, query);
      const meta = server.integration!;
      const entry = this.entry(meta.id);
      const variant = this.variant(entry, changes.variant ?? meta.variant);
      const catalogServer = this.catalogServer(variant);
      const accessLevel = changes.accessLevel ?? (variant.id === meta.variant ? meta.access_level : variant.default_access_level);
      const products =
        changes.products === null ? undefined : (changes.products ?? meta.products);
      // A variant change keeps only the params the new server declares.
      const declared = new Set(catalogServer.user_params.map((p) => p.name));
      const params = {
        ...Object.fromEntries(Object.entries(meta.params).filter(([k]) => declared.has(k))),
        ...(changes.params ?? {}),
      };
      const secretNames = variant.id === meta.variant ? meta.secrets : {};
      const toolOverrides = changes.toolOverride
        ? applyToolOverride(meta.tool_overrides, changes.toolOverride.tool, changes.toolOverride.choice)
        : meta.tool_overrides;

      const rendered = this.render(entry, variant, catalogServer, {
        accessLevel,
        products,
        params,
        secretNames,
        toolOverrides,
      });
      const next: ServerConfigInput = {
        ...rendered.server,
        enabled: server.enabled,
        ...(changes.access !== undefined
          ? accessBlock(changes.access)
          : server.access
            ? { access: server.access }
            : {}),
        integration: {
          ...meta,
          variant: variant.id,
          access_level: accessLevel,
          params: rendered.params,
          secrets: rendered.secrets,
          tool_overrides: toolOverrides,
          updated_at: this.now(),
          ...(rendered.products ? { products: rendered.products } : {}),
        },
      };
      if (!rendered.products) delete (next.integration as Partial<IntegrationMeta>).products;

      const relaunch =
        launchFingerprint(next as ServerConfig) !== launchFingerprint(server) || next.auth !== server.auth;
      if (relaunch) next.enabled = false;
      changed = changedFields(meta, server, next as ServerConfig, changes);
      if (changed.length === 0) return current;
      result = {
        name,
        server: next as ServerConfig,
        ignoredOverrides: rendered.ignoredOverrides,
        needsReview: relaunch,
      };
      return { ...current, servers: { ...current.servers, [name]: next as ServerConfig } };
    });
    if (!result) {
      const { name, server } = this.require(this.config(), query);
      return { name, server, ignoredOverrides: [], needsReview: false };
    }
    const done: IntegrationChangeResult = result;
    if (done.needsReview) this.deps.pins.forget(done.name);
    const meta = done.server.integration!;
    this.audit(changes.access !== undefined && changed.length === 1 ? "integration:access-changed" : "integration:updated", actor, {
      integration: meta.id,
      server: done.name,
      variant: meta.variant,
      changes: changed,
      access_level: meta.access_level,
      ...(changes.access !== undefined ? { access: describeAccessChoice(changes.access) } : {}),
      ...(done.needsReview ? { disabled_for_review: true } : {}),
      secrets: Object.values(meta.secrets),
    });
    return done;
  }

  /** Replace one credential. The hub picks the new value up on its next
   *  connection. */
  async rotateSecret(query: string, slot: string, value: string, actor: IntegrationActor): Promise<string> {
    const { name, server } = this.require(this.config(), query);
    const meta = server.integration!;
    const variant = this.variant(this.entry(meta.id), meta.variant);
    const catalogServer = this.catalogServer(variant);
    if (!variantSecretSlots(variant).includes(slot)) {
      const slots = variantSecretSlots(variant).join(", ") || "none";
      throw new IntegrationError(`${name} has no credential '${slot}' (credentials: ${slots})`);
    }
    const store = meta.secrets[slot] ?? slot;
    this.checkCredential(variant, catalogServer, slot, value);
    if (this.deps.secrets.exists(store)) this.deps.secrets.rotate(store, value);
    else this.deps.secrets.add(store, value);
    await updateHubConfig(this.deps.paths, (current) => {
      const target = current.servers[name];
      if (!target?.integration) throw new IntegrationError(`${name} is no longer an integration`);
      return {
        ...current,
        servers: {
          ...current.servers,
          [name]: { ...target, integration: { ...target.integration, updated_at: this.now() } },
        },
      };
    });
    this.audit("integration:updated", actor, {
      integration: meta.id,
      server: name,
      variant: meta.variant,
      changes: ["credential"],
      secrets: [store],
    });
    return store;
  }

  // ---------------------------------------------------------------------------
  // Enable / disable
  // ---------------------------------------------------------------------------

  /** Refuses (IntegrationNotReadyError) while the integration needs a
   *  login, a secret or a review, unless `force` is set. */
  async enable(query: string, actor: IntegrationActor, opts: { force?: boolean } = {}): Promise<IntegrationStatus> {
    const config = this.config();
    const { name } = this.require(config, query);
    if (!opts.force) {
      const status = this.status(name, config);
      if (blockingProblems(status).length > 0) throw new IntegrationNotReadyError(name, status);
    }
    await this.setEnabled(name, true, actor);
    return this.status(name);
  }

  async disable(query: string, actor: IntegrationActor): Promise<void> {
    const { name } = this.require(this.config(), query);
    await this.setEnabled(name, false, actor);
  }

  private async setEnabled(name: string, enabled: boolean, actor: IntegrationActor): Promise<void> {
    let meta: IntegrationMeta | null = null;
    const { changed } = await updateHubConfig(this.deps.paths, (current) => {
      const server = current.servers[name];
      if (!server?.integration) throw new IntegrationError(`${name} is no longer an integration`);
      meta = server.integration;
      if (server.enabled === enabled) return current;
      return {
        ...current,
        servers: {
          ...current.servers,
          [name]: { ...server, enabled, integration: { ...server.integration, updated_at: this.now() } },
        },
      };
    });
    if (!changed || !meta) return;
    const m: IntegrationMeta = meta;
    this.audit(enabled ? "integration:enabled" : "integration:disabled", actor, {
      integration: m.id,
      server: name,
      variant: m.variant,
    });
  }

  // ---------------------------------------------------------------------------
  // Remove
  // ---------------------------------------------------------------------------

  /** Removes the server block, its pins and its OAuth session, and the
   *  secrets no other server references (unless keepSecrets). */
  async remove(
    query: string,
    actor: IntegrationActor,
    opts: { keepSecrets?: boolean } = {},
  ): Promise<RemoveIntegrationResult> {
    let removed: { name: string; server: ServerConfig } | null = null;
    let stillUsed = new Set<string>();
    await updateHubConfig(this.deps.paths, (current) => {
      const found = this.require(current, query);
      removed = found;
      const servers = { ...current.servers };
      delete servers[found.name];
      stillUsed = new Set(Object.values(servers).flatMap((s) => referencedSecrets(s)));
      return { ...current, servers };
    });
    const { name, server } = removed as unknown as { name: string; server: ServerConfig };
    const meta = server.integration!;
    this.deps.pins.forget(name);
    let oauthSessionRemoved = false;
    if (server.auth === "oauth" && this.deps.removeOAuthSession) {
      try {
        oauthSessionRemoved = await this.deps.removeOAuthSession(name);
      } catch {
        // best-effort: the block is gone, so the session can't be used
      }
    }
    const removedSecrets: string[] = [];
    const keptSecrets: string[] = [];
    for (const secret of referencedSecrets(server)) {
      if (opts.keepSecrets || stillUsed.has(secret) || !this.deps.secrets.exists(secret)) {
        if (this.deps.secrets.exists(secret)) keptSecrets.push(secret);
        continue;
      }
      this.deps.secrets.remove(secret);
      removedSecrets.push(secret);
    }
    const variant = this.tryVariant(meta);
    this.audit("integration:removed", actor, {
      integration: meta.id,
      server: name,
      variant: meta.variant,
      secrets: referencedSecrets(server),
      removed_secrets: removedSecrets,
      kept_secrets: keptSecrets,
      oauth_session_removed: oauthSessionRemoved,
    });
    return { name, removedSecrets, keptSecrets, oauthSessionRemoved, revokeUrl: variant?.revoke_url ?? null };
  }

  // ---------------------------------------------------------------------------
  // Adopt / record
  // ---------------------------------------------------------------------------

  /** Turn a server added with `foreman mcp add` into an integration. Its
   *  block is re-rendered from the catalog; when that changes what the hub
   *  launches, the pins are forgotten and the server is disabled until it
   *  is reviewed again. */
  async adopt(
    serverName: string,
    input: { id: string; variant?: string; accessLevel?: AccessLevelId; access: AccessChoice },
    actor: IntegrationActor,
  ): Promise<IntegrationChangeResult> {
    const entry = this.entry(input.id);
    const name = serverName.trim().toLowerCase();
    let result: IntegrationChangeResult | null = null;
    await updateHubConfig(this.deps.paths, (current) => {
      const existing = current.servers[name];
      if (!existing) throw new IntegrationError(`no server named '${name}' in mcp.yaml`);
      if (existing.integration) throw new IntegrationError(`${name} is already an integration`);
      const variant = input.variant
        ? this.variant(entry, input.variant)
        : entry.variants.find((v) => v.server === existing.catalog_id);
      if (!variant) {
        throw new IntegrationError(
          `${name} was not added from a ${entry.name} catalog server — pass --variant (${entry.variants.map((v) => v.id).join(", ")})`,
        );
      }
      const server = this.catalogServer(variant);
      const accessLevel = input.accessLevel ?? variant.default_access_level;
      // A one-credential server keeps the secret name it already uses
      // (e.g. github-pat-work); otherwise the catalog's names apply.
      const used = referencedSecrets(existing);
      const slot = server.secrets.length === 1 ? server.secrets[0]!.name : null;
      const secretNames: Record<string, string> =
        slot && used.length === 1 && used[0] !== slot ? { [slot]: used[0]! } : {};
      const rendered = this.render(entry, variant, server, {
        accessLevel,
        products: undefined,
        params: undefined,
        secretNames,
        toolOverrides: undefined,
      });
      const now = this.now();
      const next: ServerConfigInput = {
        ...rendered.server,
        enabled: existing.enabled,
        ...accessBlock(input.access),
        integration: {
          id: entry.id,
          variant: variant.id,
          access_level: accessLevel,
          params: rendered.params,
          secrets: rendered.secrets,
          tool_overrides: {},
          created_at: now,
          updated_at: now,
        },
      };
      const relaunch = launchFingerprint(next as ServerConfig) !== launchFingerprint(existing) || next.auth !== existing.auth;
      if (relaunch) next.enabled = false;
      result = { name, server: next as ServerConfig, ignoredOverrides: [], needsReview: relaunch };
      return { ...current, servers: { ...current.servers, [name]: next as ServerConfig } };
    });
    const done = result as unknown as IntegrationChangeResult;
    if (done.needsReview) this.deps.pins.forget(done.name);
    const meta = done.server.integration!;
    this.audit("integration:added", actor, {
      integration: meta.id,
      server: done.name,
      variant: meta.variant,
      adopted: true,
      access_level: meta.access_level,
      access: describeAccessChoice(input.access),
      ...(done.needsReview ? { disabled_for_review: true } : {}),
      secrets: Object.values(meta.secrets),
    });
    return done;
  }

  /** Audit a user action on an integration that isn't a config change
   *  (review, test, login, logout). */
  record(
    eventType: "integration:reviewed" | "integration:tested" | "integration:login" | "integration:logout",
    query: string,
    actor: IntegrationActor,
    extra: Record<string, unknown> = {},
  ): void {
    const { name, server } = this.require(this.config(), query);
    const meta = server.integration!;
    this.audit(eventType, actor, { integration: meta.id, server: name, variant: meta.variant, ...extra });
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  private require(config: HubConfig, query: string): { name: string; server: ServerConfig } {
    const found = resolveIntegration(config, this.deps.integrationCatalog, query);
    switch (found.kind) {
      case "found":
        return { name: found.name, server: found.server };
      case "ambiguous":
        throw new IntegrationError(`'${query}' matches ${found.candidates.join(", ")} — which one?`);
      case "not-integration":
        throw new IntegrationError(`'${found.name}' is an MCP server, not an integration`);
      case "not-found":
        throw new IntegrationError(`no integration '${query}'`);
    }
  }

  private entry(idOrAlias: string): IntegrationEntry {
    const entry = findIntegration(this.deps.integrationCatalog, idOrAlias);
    if (!entry) {
      const ids = this.deps.integrationCatalog.integrations.map((e) => e.id).join(", ");
      throw new IntegrationError(`no integration '${idOrAlias}' in the catalog (available: ${ids})`);
    }
    return entry;
  }

  private variant(entry: IntegrationEntry, id: string | undefined): IntegrationVariant {
    const variant = findVariant(entry, id);
    if (!variant) {
      throw new IntegrationError(
        `${entry.name} has no variant '${id}' (variants: ${entry.variants.map((v) => v.id).join(", ")})`,
      );
    }
    return variant;
  }

  private tryVariant(meta: IntegrationMeta): IntegrationVariant | null {
    const entry = findIntegration(this.deps.integrationCatalog, meta.id);
    return entry ? findVariant(entry, meta.variant) : null;
  }

  private catalogServer(variant: IntegrationVariant): McpCatalogEntry {
    const server = findCatalogEntry(this.deps.mcpCatalog, variant.server);
    if (!server) throw new IntegrationError(`the MCP catalog has no server '${variant.server}'`);
    return server;
  }

  private render(
    entry: IntegrationEntry,
    variant: IntegrationVariant,
    server: McpCatalogEntry,
    opts: {
      accessLevel: AccessLevelId;
      products: readonly string[] | undefined;
      params: Readonly<Record<string, string>> | undefined;
      secretNames: Readonly<Record<string, string>> | undefined;
      toolOverrides: ToolRules | undefined;
    },
  ): ReturnType<typeof renderIntegration> {
    for (const name of Object.values(opts.secretNames ?? {})) {
      if (NOTIFY_SECRET_NAMES.has(name)) {
        throw new IntegrationError(`'${name}' belongs to a notification channel; pick another secret name`);
      }
    }
    try {
      return renderIntegration({
        entry,
        variant,
        server,
        accessLevel: opts.accessLevel,
        products: opts.products,
        ...(opts.params ? { params: opts.params } : {}),
        ...(opts.secretNames ? { secretNames: opts.secretNames } : {}),
        ...(opts.toolOverrides ? { toolOverrides: opts.toolOverrides } : {}),
      });
    } catch (err) {
      throw new IntegrationError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Slot → value to store, checked against the catalog's patterns. */
  private credentialValues(
    variant: IntegrationVariant,
    server: McpCatalogEntry,
    input: AddIntegrationInput,
  ): Record<string, string> {
    const slots = new Set(variantSecretSlots(variant));
    const out: Record<string, string> = {};
    for (const [slot, value] of Object.entries(input.credentials ?? {})) {
      if (!slots.has(slot)) {
        throw new IntegrationError(`${variant.label} takes no credential '${slot}'`);
      }
      this.checkCredential(variant, server, slot, value);
      out[slot] = value;
    }
    if (input.basicAuth) {
      if (variant.auth.kind !== "basic") throw new IntegrationError(`${variant.label} does not sign in with a user name and password`);
      const { username, password } = input.basicAuth;
      if (!username || username.includes(":") || !password) {
        throw new IntegrationError("a user name without ':' and a password are both required");
      }
      out[variant.auth.secret] = Buffer.from(`${username}:${password}`, "utf-8").toString("base64");
    }
    return out;
  }

  private checkCredential(variant: IntegrationVariant, server: McpCatalogEntry, slot: string, value: string): void {
    if (value.length === 0 || value.length > 8192 || /[\r\n\u0000]/.test(value)) {
      throw new IntegrationError(`the value for '${slot}' is empty, too long or has line breaks`);
    }
    const field = variant.auth.kind === "secrets" ? variant.auth.fields.find((f) => f.secret === slot) : undefined;
    const pattern = field?.pattern ?? server.secrets.find((s) => s.name === slot)?.pattern;
    if (pattern && !new RegExp(pattern).test(value)) {
      const hint = field?.format_hint ?? server.secrets.find((s) => s.name === slot)?.format_hint;
      // Never echo the value back.
      throw new IntegrationError(`that doesn't look like a valid ${field?.label ?? slot}${hint ? ` (${hint})` : ""}`);
    }
  }

  private audit(eventType: string, actor: IntegrationActor, payload: Record<string, unknown>): void {
    this.deps.audit.logEvent(eventType, { ...payload, via: actor.via, ...(actor.actor ? { actor: actor.actor } : {}) });
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}

function accessBlock(access: AccessChoice): { access?: ServerAccess } {
  if (access === "all") return {};
  const out: ServerAccess = {};
  if (access.agents) out.agents = [...new Set(access.agents)].sort();
  if (access.departments) out.departments = [...new Set(access.departments)].sort();
  return { access: out };
}

function describeAccessChoice(access: AccessChoice): unknown {
  return access === "all" ? "all-verified-agents" : accessBlock(access).access;
}

/** Field names a change touched (never values of secrets). */
function changedFields(
  before: IntegrationMeta,
  beforeServer: ServerConfig,
  after: ServerConfig,
  changes: UpdateIntegrationInput,
): string[] {
  const meta = after.integration!;
  const out: string[] = [];
  if (meta.variant !== before.variant) out.push("variant");
  if (meta.access_level !== before.access_level) out.push("access_level");
  if (JSON.stringify(meta.products ?? null) !== JSON.stringify(before.products ?? null)) out.push("products");
  if (JSON.stringify(meta.params) !== JSON.stringify(before.params)) out.push("params");
  if (JSON.stringify(meta.tool_overrides) !== JSON.stringify(before.tool_overrides)) out.push("tool_overrides");
  if (changes.access !== undefined && JSON.stringify(after.access ?? null) !== JSON.stringify(beforeServer.access ?? null)) {
    out.push("access");
  }
  return out;
}
