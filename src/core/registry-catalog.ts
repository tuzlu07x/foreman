import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getForemanPaths } from "../utils/config.js";

const REGISTRY_VERSION = 1;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_UPSTREAM_URL =
  "https://raw.githubusercontent.com/tuzlu07x/foreman/main/registry/agents.json";

export const AgentEntrySchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/, "id must be lowercase kebab-case"),
    name: z.string().min(1),
    tagline: z.string().min(1).max(80),
    homepage: z.string().url(),
    install: z
      .object({
        npm: z.string().nullable(),
        brew: z.string().nullable(),
        /** URL of a `curl | bash` style installer (Hermes, OpenClaw). */
        script: z.string().url().nullable().optional(),
        /** Override the binary name when it differs from the npm package basename. */
        binary: z.string().nullable().optional(),
        /** Args appended to script-based installers via `bash -s -- <args>` so
         *  the wizard runs non-interactively (#372). Hermes uses
         *  `["--skip-setup"]` to suppress its post-install wizard, which
         *  otherwise opens /dev/tty and deadlocks against Foreman's Ink TUI
         *  in raw mode. Ignored for npm/brew installs. */
        non_interactive_args: z.array(z.string()).optional(),
        /** When true, Foreman's projection step won't CREATE the agent's
         *  config file if it doesn't already exist — only overlay onto an
         *  existing one (#377). Defensive fallback for agents whose
         *  installer doesn't seed a config AND we don't bundle a template
         *  for. Default false. */
        requires_existing_config: z.boolean().optional(),
        /** Path (relative to registry/) to a bundled template Foreman
         *  writes when the agent's config file is missing (#385). Replaces
         *  the manual `run agent once → foreman secrets repush` dance
         *  from #378 for agents whose installers don't seed configs
         *  (OpenClaw). Template is written first, then secret projection
         *  + MCP injection overlay onto it. */
        config_template_path: z.string().min(1).optional(),
        /** Shell commands run sequentially AFTER secret projection
         *  finishes (#398). Use for service-install steps the agent's
         *  installer doesn't run itself — OpenClaw uses
         *  `["openclaw doctor --fix", "openclaw gateway install"]` to
         *  register its LaunchAgent post-config-write. Best-effort: each
         *  command's stdout/stderr is logged but a non-zero exit doesn't
         *  abort setup. The 90s idle watchdog from `runShell` applies
         *  per-command, so interactive prompts that read stdin get killed
         *  rather than hanging the wizard. */
        post_config_commands: z.array(z.string().min(1)).optional(),
      })
      .strict(),
    config_paths: z.array(z.string()),
    config_snippet: z.string().nullable().optional(),
    /** Override the top-level key for the MCP server block in this agent's
     * config. Defaults to `mcpServers` (Claude Code / Hermes / OpenClaw).
     * Codex uses `mcp_servers` (snake_case). */
    mcp_servers_key: z.string().nullable().optional(),
    /** Path Foreman writes its canonical identity into (e.g. `~/.hermes/SOUL.md`,
     * `~/.codex/AGENTS.md`). When set, `foreman agent add` propagates the
     * contents of `<foreman_home>/SOUL.md` here so the partner runtime greets
     * the user as Foreman, not its own brand. */
    identity_path: z.string().nullable().optional(),
    required_secrets: z.array(z.string()),
    optional_secrets: z.array(z.string()),
    /** Provider ids from registry/providers.json the agent can run on.
     * Empty array means "no constraint" (e.g. generic-mcp). Single-element
     * arrays mean fixed (Claude Code → anthropic). Multi-element arrays
     * drive the wizard's per-agent LLM picker (#174). Optional for
     * backward-compat — callers should read it as `entry.llm_compat ?? []`. */
    llm_compat: z.array(z.string()).optional(),
    /** Service ids from registry/services.json the agent can integrate
     * with (Telegram, Discord, etc). Drives the "Used by:" line on the
     * services step (#175) and the TUI Services page (#180). Optional —
     * callers read as `entry.optional_services ?? []`. */
    optional_services: z.array(z.string()).optional(),
    mcp_compatible: z.boolean(),
    /** MCP config block shape (#385). `flat` writes `{<mcp_servers_key>:
     *  {foreman: ...}}` (Claude Code / Hermes / Codex). `nested` writes
     *  `{mcp: {enabled: true, servers: {foreman: ...}}}` (OpenClaw).
     *  Default `flat` for backward-compat. */
    mcp_format: z.enum(["flat", "nested"]).optional(),
    supported_versions: z.string().min(1),
    min_foreman_version: z.string().min(1),
    /** Optional background daemon (#349). When set, `foreman start` spawns
     *  this command + tracks the PID in `<stateDir>/daemons/<id>.pid`;
     *  shutdown sends SIGTERM. Null = the agent has no long-running
     *  process (e.g. CLI-only agents like generic-mcp). */
    daemon: z
      .object({
        command: z.string().min(1),
        args: z.array(z.string()).optional(),
        /** Human-readable label for the TUI Agents page status row. */
        label: z.string().min(1).optional(),
      })
      .nullable()
      .optional(),
    /** Some agents (Hermes notably) maintain their own MCP server registry
     *  CLI-side rather than reading the YAML/JSON config block we inject.
     *  When set, the wizard's install log surfaces the CLI command the user
     *  has to run to wire Foreman into the agent's registry (#298). The
     *  `{agent_id}` token is substituted with the actual registered agent
     *  id (matches what we record in `--source`). */
    mcp_register_cli: z
      .object({
        command_template: z.string().min(1),
        verify_template: z.string().min(1).optional(),
        note: z.string().optional(),
        /** Some agents (Hermes #346) mangle multi-token `--args` strings,
         *  so the documented `--args "mcp-stdio --source X"` invocation
         *  never connects. When set, Foreman writes a tiny wrapper script
         *  at `path_template` and the install hint points the agent at the
         *  wrapper instead. `{wrapper_path}` is substituted in
         *  `command_template`. `{agent_id}` is substituted in
         *  `path_template` + `content_template`. */
        wrapper: z
          .object({
            path_template: z.string().min(1),
            content_template: z.string().min(1),
          })
          .optional(),
      })
      .optional(),
    /** Where to project Foreman secrets so this agent picks them up at startup
     *  (#222 / #223). When set, after MCP injection the install flow:
     *    1. iterates `env_vars` and `channels`,
     *    2. filters by `if_provider` / `if_service` against the user's picks,
     *    3. fetches each secret from Foreman's secret store,
     *    4. dispatches to the appropriate writer (dotenv, json-env, toml-field,
     *       json-channels) so the agent can simply read its usual env var or
     *       config file.
     *  Omit the block entirely for agents that don't need projection
     *  (generic-mcp). */
    secret_projection: z
      .object({
        /** Dotenv file path (Hermes uses `~/.hermes/.env`). Null when the
         *  agent doesn't have a dotenv. */
        env_file: z.string().nullable().optional(),
        /** Map of env-var name → secret descriptor. The writer chosen depends
         *  on whether `env_file` is set (dotenv) or `json_env_path` is set
         *  (Claude Code's settings.json) etc. */
        env_vars: z
          .record(
            z.object({
              from_secret: z.string().min(1),
              /** Only project when this provider is in the user's selection. */
              if_provider: z.string().optional(),
              /** Only project when this service is in the user's selection. */
              if_service: z.string().optional(),
            }),
          )
          .optional(),
        /** JSON file + key path for an `env` block (Claude Code's
         *  `~/.claude/settings.json` → `env`, OpenClaw's
         *  `~/.openclaw/openclaw.json` → `env`). */
        json_env: z
          .object({
            path: z.string().min(1),
            /** Dot-path to the env object inside the file (e.g. "env"). */
            section: z.string().min(1),
          })
          .optional(),
        /** TOML file + simple top-level key=value writes (Codex's
         *  `preferred_auth_method = "apikey"`, ZeroClaw's `api_key = "…"`). */
        toml_writes: z
          .array(
            z.object({
              path: z.string().min(1),
              key: z.string().min(1),
              /** Literal value, OR a secret reference like
               *  `{ from_secret: "openai-key" }`. */
              value: z.union([
                z.string(),
                z.object({ from_secret: z.string().min(1) }),
              ]),
            }),
          )
          .optional(),
        /** JSON file + nested-channel writes (OpenClaw channels.*). */
        json_channels: z
          .object({
            path: z.string().min(1),
            channels: z.record(
              z.object({
                /** Dot-path inside the JSON for this channel's token. */
                path: z.string().min(1),
                from_secret: z.string().min(1),
                if_service: z.string().optional(),
              }),
            ),
          })
          .optional(),
        /** Auth-file written as plain JSON (Codex's `~/.codex/auth.json`). */
        auth_json: z
          .object({
            path: z.string().min(1),
            key: z.string().min(1),
            from_secret: z.string().min(1),
            if_provider: z.string().optional(),
          })
          .optional(),
        /** #389 — Per-provider config overrides written to the agent's own
         *  config file after install (Hermes config.yaml `model.provider`,
         *  OpenClaw openclaw.json `agents.defaults.provider`, etc).
         *  Solves the #350 root cause: Foreman projects env keys but the
         *  agent's config defaults to a different provider, so the keys
         *  are ignored. Each write filters by `if_provider` / `if_service`
         *  against the user's per-agent choice; matching writes are
         *  deep-merged into the existing file. */
        config_overrides: z
          .object({
            path: z.string().min(1),
            format: z.enum(["yaml", "json"]),
            writes: z.array(
              z.object({
                if_provider: z.string().optional(),
                if_service: z.string().optional(),
                /** Dot-path → value pairs. Each path written via deep
                 *  merge so siblings the user added survive. */
                set: z.record(
                  z.union([z.string(), z.boolean(), z.number(), z.null()]),
                ),
              }),
            ),
          })
          .optional(),
        /** Shown on the wizard's Done screen — what command to run to start
         *  this agent. Single string OR an array of `{command, label}` for
         *  agents with multiple modes (e.g. Hermes chat vs gateway). */
        launch: z
          .union([
            z.string().min(1),
            z.array(
              z.object({
                command: z.string().min(1),
                label: z.string().min(1),
              }),
            ),
          ])
          .optional(),
        /** Post-projection provider-conflict check (#350). Many agents have
         *  a `provider:` field in their own config that takes priority over
         *  the env vars Foreman writes. If the agent's config still names a
         *  different provider than the one Foreman wired up, the agent
         *  silently keeps using the old one — the user thinks Foreman is
         *  broken. This block tells Foreman where to look + how to warn. */
        provider_check: z
          .object({
            /** Config file to read (`~` expanded). */
            path: z.string().min(1),
            /** File format — drives parsing. */
            format: z.enum(["yaml", "json"]),
            /** Dot-path to the provider field inside the parsed config. */
            key: z.string().min(1),
            /** Optional CLI command the user can run to fix the mismatch
             *  (e.g. `hermes model` opens Hermes' provider picker). */
            fix_command: z.string().optional(),
          })
          .optional(),
        /** #396 — Agent-side security fields that block end-to-end usage if
         *  unset, even though they don't carry user-supplied secrets.
         *  OpenClaw's gateway refuses Telegram traffic without
         *  `gateway.auth.token` (now mandatory, even on loopback) AND
         *  `commands.ownerAllowFrom` (the paired Telegram chat id);
         *  without these the daemon starts but every DM is silently
         *  blocked / pair-prompted. */
        security_bootstrap: z
          .object({
            /** Config file to write into (`~` expanded). */
            path: z.string().min(1),
            /** File format — drives parsing + serialization. */
            format: z.enum(["yaml", "json"]),
            /** Random token auto-generated when the dot-path is empty.
             *  Preserved on subsequent runs so the gateway's clients (the
             *  agent's own UI, MCP transport, etc) don't have to be
             *  re-credentialed every wizard re-run. */
            auth_token: z
              .object({
                /** Dot-path to the token field in the config. */
                key: z.string().min(1),
                /** Random bytes to generate (32 = 256-bit token). */
                bytes: z.number().int().min(16).max(64),
                /** Encoding for the generated value. */
                encoding: z.enum(["hex", "base64", "base64url"]),
              })
              .optional(),
            /** Owner allowlist projected from a Foreman-stored secret —
             *  e.g. OpenClaw's `commands.ownerAllowFrom: ["telegram:<chatId>"]`
             *  derived from the `telegram-chat-id` secret. Overwrites the
             *  array on every run (deterministic given the same input). */
            owner_allowlist: z
              .object({
                /** Dot-path to the array field. */
                key: z.string().min(1),
                /** Secret to read the raw chat id from. */
                from_secret: z.string().min(1),
                /** Template applied to the secret value. `{value}` is
                 *  substituted. Use `telegram:{value}` to produce
                 *  `telegram:123456789`. */
                item_template: z.string().min(1),
                /** Only project when this service is in the user's
                 *  selection (Telegram, Discord, …). */
                if_service: z.string().min(1).optional(),
              })
              .optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .strict();

export const RegistryDocSchema = z
  .object({
    version: z.literal(REGISTRY_VERSION),
    agents: z.array(AgentEntrySchema),
  })
  .strict();

export type AgentEntry = z.infer<typeof AgentEntrySchema>;
export type RegistryDoc = z.infer<typeof RegistryDocSchema>;

// Provider entries are intentionally not strict: unknown keys pass through so
// v0.2+ can add fields (default_model, rate_limit_hints, …) without forcing
// an in-lockstep release of the catalog and the parser.
export const ProviderEntrySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "id must be lowercase kebab-case"),
  name: z.string().min(1),
  description: z.string().min(1),
  secret_name: z.string().nullable(),
  /** Optional expected prefix for paste-time validation in the wizard
   *  (#291) — warns when the user pastes a key that doesn't start with
   *  this, surfacing cross-provider mistakes early (e.g. OpenAI sk-proj-
   *  pasted into the Anthropic slot). Nullable so providers without a
   *  stable prefix convention (Ollama, custom) opt out. */
  key_prefix: z.string().nullable().optional(),
  where_to_get: z.string().url().nullable(),
  format_hint: z.string().nullable(),
  instructions: z.array(z.string()),
  endpoint_default: z.string().nullable(),
  endpoint_required: z.boolean(),
});

export const ProviderCatalogSchema = z.object({
  version: z.literal(REGISTRY_VERSION),
  providers: z.array(ProviderEntrySchema),
});

export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;
export type ProviderCatalog = z.infer<typeof ProviderCatalogSchema>;

// Extra (non-primary) secrets a service may need — e.g. Telegram needs both
// the bot token AND a chat id, Webhook needs URL + signing secret. The primary
// secret is the service's auth credential (`secret_name`); extras are usually
// destination / scope hints. Each extra is rendered as its own wizard prompt
// after the primary, with its own setup steps. Default `optional: true` so a
// fresh user can skip and configure later from the Secrets page (#220).
export const ExtraServiceSecretSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  format_hint: z.string().min(1),
  where_to_get: z.string().url().nullable().optional(),
  setup_steps: z.array(z.string().min(1)).min(1),
  optional: z.boolean().default(true),
});
export type ExtraServiceSecret = z.infer<typeof ExtraServiceSecretSchema>;

// Service entries are also non-strict so v0.2+ can add fields like
// rate_limit_hints or oauth_redirect_uri without forcing a parser release.
export const ServiceEntrySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "id must be lowercase kebab-case"),
  name: z.string().min(1),
  description: z.string().min(1),
  secret_name: z.string().min(1),
  where_to_get: z.string().url(),
  format_hint: z.string().min(1),
  setup_steps: z.array(z.string().min(1)).min(1),
  used_by_agents: z.array(z.string()),
  open_url_hotkey: z.boolean(),
  /** Additional secrets prompted for after the primary one — e.g. Telegram
   *  chat id, webhook signing secret. Optional; missing/empty array means the
   *  primary secret is the only thing to ask for. */
  extra_secrets: z.array(ExtraServiceSecretSchema).default([]),
});

export const ServiceCatalogSchema = z.object({
  version: z.literal(REGISTRY_VERSION),
  services: z.array(ServiceEntrySchema),
});

export type ServiceEntry = z.infer<typeof ServiceEntrySchema>;
export type ServiceCatalog = z.infer<typeof ServiceCatalogSchema>;

export class RegistryNotFoundError extends Error {
  constructor() {
    super(
      "Bundled registry/agents.json was not found. Re-install the foreman-agent package or run from a checked-out repo.",
    );
    this.name = "RegistryNotFoundError";
  }
}

export class AgentNotInRegistryError extends Error {
  constructor(public readonly agentId: string) {
    super(`No agent with id "${agentId}" in the registry`);
    this.name = "AgentNotInRegistryError";
  }
}

export class ProviderCatalogNotFoundError extends Error {
  constructor() {
    super(
      "Bundled registry/providers.json was not found. Re-install the foreman-agent package or run from a checked-out repo.",
    );
    this.name = "ProviderCatalogNotFoundError";
  }
}

export class ProviderNotInCatalogError extends Error {
  constructor(public readonly providerId: string) {
    super(`No provider with id "${providerId}" in the catalog`);
    this.name = "ProviderNotInCatalogError";
  }
}

export class ProviderCatalogValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: { path: string; message: string }[],
  ) {
    super(message);
    this.name = "ProviderCatalogValidationError";
  }
}

export class ServiceCatalogNotFoundError extends Error {
  constructor() {
    super(
      "Bundled registry/services.json was not found. Re-install the foreman-agent package or run from a checked-out repo.",
    );
    this.name = "ServiceCatalogNotFoundError";
  }
}

export class ServiceNotInCatalogError extends Error {
  constructor(public readonly serviceId: string) {
    super(`No service with id "${serviceId}" in the catalog`);
    this.name = "ServiceNotInCatalogError";
  }
}

export class ServiceCatalogValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: { path: string; message: string }[],
  ) {
    super(message);
    this.name = "ServiceCatalogValidationError";
  }
}

export class RegistryValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: { path: string; message: string }[],
  ) {
    super(message);
    this.name = "RegistryValidationError";
  }
}

// Resolves the bundled registry/agents.json that ships with the package.
// Looks in dev (src) and bundled (dist) layouts plus the current working dir.
export function resolveBundledRegistryPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "..", "registry", "agents.json"),
    resolve(here, "..", "..", "registry", "agents.json"),
    resolve(here, "..", "registry", "agents.json"),
    resolve(process.cwd(), "registry", "agents.json"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export function getRegistryCachePath(): string {
  return resolve(getForemanPaths().cacheDir, "registry.json");
}

/** #385 — Resolve a bundled config template path stored in the registry
 *  entry. Same convention as `config_snippet`: paths are project-root
 *  relative (e.g. "registry/templates/openclaw.json"). Returns null if
 *  the file isn't found; callers fall back to either the
 *  `requires_existing_config` skip path or "create from scratch". */
export function resolveBundledTemplatePath(
  projectRootRelative: string,
): string | null {
  const registryPath = resolveBundledRegistryPath();
  if (!registryPath) return null;
  const registryRoot = registryPath.replace(/agents\.json$/, "");
  const candidate = resolve(registryRoot, "..", projectRootRelative);
  return existsSync(candidate) ? candidate : null;
}

export function getUpstreamRegistryUrl(): string {
  return process.env.FOREMAN_REGISTRY_URL ?? DEFAULT_UPSTREAM_URL;
}

export function parseRegistryText(
  text: string,
  /** Optional source path — used only to make error messages reference the
   *  actual file the caller is parsing (#270). Defaults to the historical
   *  literal so old callers stay backwards-compatible. */
  source: string = "registry/agents.json",
): RegistryDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new RegistryValidationError(
      `${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      [],
    );
  }
  const parsed = RegistryDocSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RegistryValidationError(
      `${source} failed schema validation`,
      parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    );
  }
  return parsed.data;
}

export function loadBundledRegistry(): RegistryDoc {
  const path = resolveBundledRegistryPath();
  if (!path) throw new RegistryNotFoundError();
  return parseRegistryText(readFileSync(path, "utf-8"), path);
}

// Picks the cached copy if present and within TTL, otherwise the bundled one.
// The cache is populated by `foreman registry update`.
export function loadActiveRegistry(now: number = Date.now()): {
  doc: RegistryDoc;
  source: "cache" | "bundled";
  cachedAt?: number;
} {
  const cachePath = getRegistryCachePath();
  if (existsSync(cachePath)) {
    try {
      const raw = JSON.parse(readFileSync(cachePath, "utf-8")) as {
        cachedAt?: number;
        doc?: unknown;
      };
      const cachedAt = typeof raw.cachedAt === "number" ? raw.cachedAt : 0;
      if (now - cachedAt < CACHE_TTL_MS && raw.doc) {
        const parsed = RegistryDocSchema.safeParse(raw.doc);
        if (parsed.success) {
          return { doc: parsed.data, source: "cache", cachedAt };
        }
      }
    } catch {
      /* fall through to bundled */
    }
  }
  return { doc: loadBundledRegistry(), source: "bundled" };
}

export function writeRegistryCache(
  doc: RegistryDoc,
  cachedAt: number = Date.now(),
): void {
  const cachePath = getRegistryCachePath();
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ cachedAt, doc }, null, 2), "utf-8");
}

export function findAgent(doc: RegistryDoc, agentId: string): AgentEntry {
  const entry = doc.agents.find((a) => a.id === agentId);
  if (!entry) throw new AgentNotInRegistryError(agentId);
  return entry;
}

export function resolveBundledProvidersPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "..", "registry", "providers.json"),
    resolve(here, "..", "..", "registry", "providers.json"),
    resolve(here, "..", "registry", "providers.json"),
    resolve(process.cwd(), "registry", "providers.json"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export function parseProviderCatalogText(text: string): ProviderCatalog {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ProviderCatalogValidationError(
      `registry/providers.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      [],
    );
  }
  const parsed = ProviderCatalogSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProviderCatalogValidationError(
      "registry/providers.json failed schema validation",
      parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    );
  }
  return parsed.data;
}

export function loadBundledProviders(): ProviderCatalog {
  const path = resolveBundledProvidersPath();
  if (!path) throw new ProviderCatalogNotFoundError();
  return parseProviderCatalogText(readFileSync(path, "utf-8"));
}

// No cache layer yet — the provider catalog is small and the only writer is
// the bundled JSON. When/if `foreman registry update` adds providers we can
// mirror the agent-catalog cache shape; until then bundle is the source.
export function loadActiveProviders(): {
  doc: ProviderCatalog;
  source: "bundled";
} {
  return { doc: loadBundledProviders(), source: "bundled" };
}

export function findProvider(
  doc: ProviderCatalog,
  providerId: string,
): ProviderEntry {
  const entry = doc.providers.find((p) => p.id === providerId);
  if (!entry) throw new ProviderNotInCatalogError(providerId);
  return entry;
}

export function resolveBundledServicesPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "..", "registry", "services.json"),
    resolve(here, "..", "..", "registry", "services.json"),
    resolve(here, "..", "registry", "services.json"),
    resolve(process.cwd(), "registry", "services.json"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export function parseServiceCatalogText(text: string): ServiceCatalog {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ServiceCatalogValidationError(
      `registry/services.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      [],
    );
  }
  const parsed = ServiceCatalogSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ServiceCatalogValidationError(
      "registry/services.json failed schema validation",
      parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    );
  }
  return parsed.data;
}

export function loadBundledServices(): ServiceCatalog {
  const path = resolveBundledServicesPath();
  if (!path) throw new ServiceCatalogNotFoundError();
  return parseServiceCatalogText(readFileSync(path, "utf-8"));
}

export function loadActiveServices(): {
  doc: ServiceCatalog;
  source: "bundled";
} {
  return { doc: loadBundledServices(), source: "bundled" };
}

export function findService(
  doc: ServiceCatalog,
  serviceId: string,
): ServiceEntry {
  const entry = doc.services.find((s) => s.id === serviceId);
  if (!entry) throw new ServiceNotInCatalogError(serviceId);
  return entry;
}

// Cross-catalog check: every id in any service.used_by_agents must exist as an
// agent entry. Run from CI / tests to catch typos when a service or agent is
// renamed; not called at runtime to keep the load path cheap.
export function validateServicesAgainstAgents(
  services: ServiceCatalog,
  agents: RegistryDoc,
): { ok: true } | { ok: false; missing: { service: string; agent: string }[] } {
  const agentIds = new Set(agents.agents.map((a) => a.id));
  const missing: { service: string; agent: string }[] = [];
  for (const service of services.services) {
    for (const agentId of service.used_by_agents) {
      if (!agentIds.has(agentId)) {
        missing.push({ service: service.id, agent: agentId });
      }
    }
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

export interface CatalogCrossRefIssue {
  source: "agent" | "service";
  sourceId: string;
  field: "llm_compat" | "optional_services" | "used_by_agents";
  missing: string;
}

// Cross-catalog typo check: every id an agent or service refers to must
// resolve to a real entry in the relevant catalog. Run from CI / tests
// before publishing the registry; not called at runtime to keep the load
// path cheap.
export function validateAgentsAgainstCatalogs(
  agents: RegistryDoc,
  providers: ProviderCatalog,
  services: ServiceCatalog,
): { ok: true } | { ok: false; issues: CatalogCrossRefIssue[] } {
  const providerIds = new Set(providers.providers.map((p) => p.id));
  const serviceIds = new Set(services.services.map((s) => s.id));
  const agentIds = new Set(agents.agents.map((a) => a.id));
  const issues: CatalogCrossRefIssue[] = [];
  for (const agent of agents.agents) {
    for (const id of agent.llm_compat ?? []) {
      if (!providerIds.has(id)) {
        issues.push({
          source: "agent",
          sourceId: agent.id,
          field: "llm_compat",
          missing: id,
        });
      }
    }
    for (const id of agent.optional_services ?? []) {
      if (!serviceIds.has(id)) {
        issues.push({
          source: "agent",
          sourceId: agent.id,
          field: "optional_services",
          missing: id,
        });
      }
    }
  }
  for (const service of services.services) {
    for (const id of service.used_by_agents) {
      if (!agentIds.has(id)) {
        issues.push({
          source: "service",
          sourceId: service.id,
          field: "used_by_agents",
          missing: id,
        });
      }
    }
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export const REGISTRY_CACHE_TTL_MS = CACHE_TTL_MS;
