import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { SECRET_NAME_PATTERN } from "../secret-store.js";

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

const GlobListSchema = z.array(z.string().min(1).max(200)).max(200);

const ToolRulesSchema = z
  .object({
    /** Policy-level allow when policy.yaml has no matching rule. The risk
     *  engine still runs, so a risky call is still escalated. */
    allow: GlobListSchema.optional(),
    /** Always ask a human, unless policy.yaml says otherwise. */
    ask: GlobListSchema.optional(),
    /** Never exposed to agents; calls are refused. Wins over allow/ask. */
    deny: GlobListSchema.optional(),
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

/** deny > ask > allow; `null` when no rule mentions the tool. */
export function toolRuleEffect(rules: ToolRules, toolName: string): ToolRuleEffect | null {
  if (matchesAnyGlob(toolName, rules.deny)) return "deny";
  if (matchesAnyGlob(toolName, rules.ask)) return "ask";
  if (matchesAnyGlob(toolName, rules.allow)) return "allow";
  return null;
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
