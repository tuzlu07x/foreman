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

const SecretSpecSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    description: z.string().min(1),
    where_to_get: z.string().url().optional(),
  })
  .strict();

const CatalogToolRulesSchema = z
  .object({
    allow: z.array(z.string().min(1)).optional(),
    ask: z.array(z.string().min(1)).optional(),
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
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    secrets: z.array(SecretSpecSchema).default([]),
    /** Extra positional args the user must supply (e.g. allowed dirs). */
    user_args: z
      .object({ description: z.string().min(1), example: z.array(z.string()).min(1) })
      .strict()
      .optional(),
    tools: CatalogToolRulesSchema.default({}),
    notes: z.string().optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.transport === "stdio" && !e.command) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "stdio entries need `command`" });
    }
    if (e.transport === "http" && !e.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "http entries need `url`" });
    }
    const declared = new Set(e.secrets.map((s) => s.name));
    const blob = JSON.stringify([e.env, e.headers, e.args, e.url ?? ""]);
    for (const m of blob.matchAll(/\$\{secret:([^}]+)\}/g)) {
      if (!declared.has(m[1]!)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `references undeclared secret '${m[1]}'`,
        });
      }
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

/** Turn a catalog entry into an mcp.yaml server block. */
export function serverConfigFromCatalog(
  entry: McpCatalogEntry,
  extraArgs: readonly string[] = [],
): ServerConfigInput {
  const base: ServerConfigInput = {
    enabled: true,
    catalog_id: entry.id,
    tools: { ...entry.tools },
  };
  if (entry.transport === "http") {
    return { ...base, url: entry.url!, headers: { ...entry.headers } };
  }
  return {
    ...base,
    command: entry.command!,
    args: [...entry.args, ...extraArgs],
    env: { ...entry.env },
  };
}
