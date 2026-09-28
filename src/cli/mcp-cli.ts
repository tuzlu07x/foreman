import { existsSync } from "node:fs";
import { Command } from "commander";
import { ZodError } from "zod";
import { loadBundledMcpCatalog, type McpCatalogEntry } from "../core/mcp-hub/catalog.js";
import {
  defaultHubConfig,
  loadHubConfig,
  updateHubConfig,
  type HubConfig,
  type HubMode,
} from "../core/mcp-hub/config.js";
import { compactForAgent, estimateTokens, McpHub, type HubTool } from "../core/mcp-hub/hub.js";
import {
  addServer,
  HubConfigEditError,
  missingSecrets,
  removeServer,
  setMode,
  setServerEnabled,
} from "../core/mcp-hub/manage.js";
import { hubOAuthSessions, mcpOAuthLockPath } from "../core/mcp-hub/boot.js";
import { removeMcpOAuthSession } from "../core/mcp-hub/oauth-session.js";
import { describeMcpOAuthStatus, mcpOAuthStatus } from "../core/mcp-hub/oauth-store.js";
import { ToolPinStore } from "../core/mcp-hub/pins.js";
import { SecretStore } from "../core/secret-store.js";
import { closeDb, getDb } from "../db/client.js";
import { loadOrCreateSecretsMasterKey } from "../identity/master-key.js";
import { getForemanPaths } from "../utils/config.js";
import { bold, dim, green, orange, red } from "./colors.js";
import {
  cliOAuthLogin,
  cliOAuthLogout,
  DEFAULT_LOGIN_TIMEOUT_MS,
  loginTimeoutSeconds,
  MAX_LOGIN_TIMEOUT_MS,
} from "./oauth-cli-shared.js";

// =============================================================================
// `foreman mcp` — the MCP hub: one place to connect every agent to GitHub,
// Notion, Stripe, a browser… with each call mediated by Foreman.
// =============================================================================

export const mcpCommand = new Command("mcp").description(
  "MCP hub — connect upstream MCP servers once, mediate every agent's calls to them",
);

mcpCommand
  .command("catalog")
  .description("List the curated MCP servers `foreman mcp add` knows")
  .option("--category <category>", "only show one category (developer, productivity, …)")
  .option("--json", "output JSON")
  .action((opts: { category?: string; json?: boolean }) => {
    const catalog = loadBundledMcpCatalog();
    const entries = catalog.servers.filter((s) => !opts.category || s.category === opts.category);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
      return;
    }
    const byCategory = new Map<string, McpCatalogEntry[]>();
    for (const e of entries) byCategory.set(e.category, [...(byCategory.get(e.category) ?? []), e]);
    for (const [category, list] of byCategory) {
      console.log(orange(category));
      for (const e of list) {
        const badge = e.official ? green("official") : dim("community");
        const status = e.status ? ` ${dim("·")} ${orange(e.status)}` : "";
        console.log(`  ${bold(e.id.padEnd(18))} ${e.description} ${dim("·")} ${badge}${status}`);
      }
      console.log("");
    }
    console.log(dim("Add one: foreman mcp add <id>   ·   details: foreman mcp catalog --json"));
  });

mcpCommand
  .command("add <id> [args...]")
  .description(
    "Add a server from the catalog (e.g. `foreman mcp add github`) or a custom one (--command / --url)",
  )
  .option("--name <name>", "name in mcp.yaml (default: the id)")
  .option("--command <command>", "custom stdio server command (args follow the id)")
  .option("--url <url>", "custom streamable-HTTP server URL (https://)")
  .option(
    "--env <KEY=VALUE>",
    "environment variable for the server; use ${secret:name} for secrets (repeatable)",
    collectPairs,
    {},
  )
  .option("--header <KEY=VALUE>", "HTTP header for a remote server (repeatable)", collectPairs, {})
  .option(
    "--param <KEY=VALUE>",
    "value for a catalog server's parameter, e.g. host=gitlab.example.com (repeatable)",
    collectPairs,
    {},
  )
  .option("--oauth", "the remote server uses MCP OAuth — sign in with `foreman mcp login <name>`")
  .option("--force", "replace an existing server with the same name")
  .action(
    async (
      id: string,
      args: string[],
      opts: {
        name?: string;
        command?: string;
        url?: string;
        env: Record<string, string>;
        header: Record<string, string>;
        param: Record<string, string>;
        oauth?: boolean;
        force?: boolean;
      },
    ) => {
      requireInitialised();
      const paths = getForemanPaths();
      const catalog = loadBundledMcpCatalog();
      let next: HubConfig;
      try {
        ({ after: next } = await updateHubConfig(paths, (current) =>
          addServer(current, catalog, {
            id,
            ...(opts.name ? { name: opts.name } : {}),
            extraArgs: args,
            ...(Object.keys(opts.param).length > 0 ? { params: opts.param } : {}),
            ...(opts.command ? { command: opts.command } : {}),
            ...(opts.url ? { url: opts.url } : {}),
            ...(Object.keys(opts.env).length > 0 ? { env: opts.env } : {}),
            ...(Object.keys(opts.header).length > 0 ? { headers: opts.header } : {}),
            ...(opts.oauth ? { auth: "oauth" as const } : {}),
            ...(opts.force ? { force: true } : {}),
          }),
        ));
      } catch (err) {
        fail(err);
      }
      const name = opts.name ?? id;
      console.log(`${green("✓")} added ${bold(name)} to ${dim(paths.mcpConfigPath)}`);
      reportSecrets(next, name);
      if (next.servers[name]?.auth === "oauth") {
        console.log(orange(`  sign in (tokens stay in Foreman's encrypted store): foreman mcp login ${name}`));
      }
      console.log(
        dim(
          "Every agent connected through `foreman mcp-stdio` now sees this server's tools. " +
            "Review them with `foreman mcp tools " +
            name +
            "`.",
        ),
      );
    },
  );

mcpCommand
  .command("list")
  .description("Show configured MCP servers")
  .option("--json", "output JSON")
  .action((opts: { json?: boolean }) => {
    requireInitialised();
    const paths = getForemanPaths();
    const config = readConfig(paths.mcpConfigPath);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
      return;
    }
    const names = Object.keys(config.servers);
    if (names.length === 0) {
      console.log(dim("No MCP servers yet — try `foreman mcp catalog` then `foreman mcp add <id>`."));
      return;
    }
    const store = openSecretStore();
    for (const name of names) {
      const s = config.servers[name]!;
      const flag = s.enabled ? green("●") : dim("○");
      const where = s.url ? s.url : [s.command, ...s.args].join(" ");
      const missing = missingSecrets(config, name, (n) => store.exists(n));
      const secretNote =
        missing.length > 0 ? red(` missing secrets: ${missing.join(", ")}`) : "";
      console.log(`  ${flag} ${bold(name.padEnd(18))} ${dim(where)}${secretNote}`);
      if (s.auth === "oauth") {
        const status = mcpOAuthStatus(store, name, s.url);
        const text = `oauth: ${describeMcpOAuthStatus(name, status)}`;
        console.log(`    ${" ".repeat(18)} ${status.state === "needs-login" ? orange(text) : green(text)}`);
      }
    }
    console.log("");
    console.log(dim(`mode: ${config.mode} · result cap ${config.limits.max_result_chars} chars`));
    closeDb();
  });

mcpCommand
  .command("remove <name>")
  .description("Remove a server (and its pinned tool definitions)")
  .action(async (name: string) => {
    requireInitialised();
    const paths = getForemanPaths();
    try {
      await updateHubConfig(paths, (current) => removeServer(current, name));
      new ToolPinStore(paths.mcpPinsPath).forget(name);
      await removeMcpOAuthSession(openSecretStore(), name, mcpOAuthLockPath(paths, name));
    } catch (err) {
      fail(err);
    } finally {
      closeDb();
    }
    console.log(`${green("✓")} removed ${bold(name)}`);
  });

mcpCommand
  .command("login <name>")
  .description("Sign in to a server marked `auth: oauth` (MCP authorization flow in your browser)")
  .option("--scope <scopes>", "space-separated scopes to request (default: none — the server's default grant)")
  .option("--no-browser", "only print the URL; do not try to open a browser")
  .option(
    "--timeout <seconds>",
    `how long to wait for the browser sign-in (max ${MAX_LOGIN_TIMEOUT_MS / 1000})`,
    String(DEFAULT_LOGIN_TIMEOUT_MS / 1000),
  )
  .action(async (name: string, opts: { scope?: string; browser: boolean; timeout: string }) => {
    requireInitialised();
    const paths = getForemanPaths();
    const server = readConfig(paths.mcpConfigPath).servers[name];
    if (!server) fail(new Error(`no server named '${name}' in mcp.yaml`));
    if (server.auth !== "oauth" || !server.url) {
      fail(
        new Error(
          `'${name}' is not an OAuth server — set \`auth: oauth\` on it in mcp.yaml, or add it with \`foreman mcp add ${name} --url <url> --oauth\``,
        ),
      );
    }
    try {
      await cliOAuthLogin(paths, openSecretStore(), name, server.url, {
        ...(opts.scope ? { scope: opts.scope } : {}),
        browser: opts.browser,
        timeoutSeconds: loginTimeoutSeconds(opts.timeout),
      });
    } catch (err) {
      fail(err);
    } finally {
      closeDb();
    }
  });

mcpCommand
  .command("logout <name>")
  .description("Delete the stored OAuth session for a server (and revoke it at the provider if it can)")
  .action(async (name: string) => {
    requireInitialised();
    try {
      await cliOAuthLogout(getForemanPaths(), openSecretStore(), name);
    } catch (err) {
      fail(err);
    } finally {
      closeDb();
    }
  });

for (const [verb, enabled] of [
  ["enable", true],
  ["disable", false],
] as const) {
  mcpCommand
    .command(`${verb} <name>`)
    .description(`${enabled ? "Enable" : "Disable"} a configured server`)
    .action(async (name: string) => {
      requireInitialised();
      const paths = getForemanPaths();
      try {
        await updateHubConfig(paths, (current) => setServerEnabled(current, name, enabled));
      } catch (err) {
        fail(err);
      }
      console.log(`${green("✓")} ${name} ${enabled ? "enabled" : "disabled"}`);
    });
}

mcpCommand
  .command("mode <mode>")
  .description(
    "How agents discover hub tools: eager (list all), lazy (search + call, fewest tokens), auto (lazy above the threshold)",
  )
  .action(async (mode: string) => {
    requireInitialised();
    if (mode !== "auto" && mode !== "eager" && mode !== "lazy") {
      fail(new Error("mode must be auto, eager or lazy"));
    }
    const paths = getForemanPaths();
    try {
      await updateHubConfig(paths, (current) => setMode(current, mode as HubMode));
    } catch (err) {
      fail(err);
    }
    console.log(`${green("✓")} MCP hub mode = ${mode}`);
  });

mcpCommand
  .command("tools [name]")
  .description("Connect to servers, list their tools, scan findings and token cost")
  .option("--refresh", "ignore the pinned cache and ask the live servers")
  .option("--json", "output JSON")
  .action(async (name: string | undefined, opts: { refresh?: boolean; json?: boolean }) => {
    requireInitialised();
    const { hub, config } = openHub();
    try {
      const tools = await hub.inventory({
        refresh: opts.refresh === true,
        ...(name ? { servers: [name] } : {}),
      });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ servers: hub.status(), tools }, null, 2)}\n`);
        return;
      }
      for (const status of hub.status().filter((s) => !name || s.name === name)) {
        const state =
          status.source === "unavailable" ? red(`unavailable — ${status.error ?? "unknown error"}`) : dim(status.source);
        console.log(`${orange(status.name)} ${state}`);
        for (const t of tools.filter((x) => x.server === status.name)) printTool(t);
        if (status.newSincePinning.length > 0) {
          console.log(`  ${red("⚠")} new since pinning, withheld: ${status.newSincePinning.join(", ")}`);
        }
        if (status.source === "pinned-cache" && tools.some((x) => x.server === status.name && x.status === "quarantined")) {
          console.log(dim(`  Compare with the live server: foreman mcp tools ${status.name} --refresh`));
        }
        console.log("");
      }
      printTokenReport(tools, config);
    } finally {
      await hub.close();
      closeDb();
    }
  });

mcpCommand
  .command("trust <name>")
  .description("Accept a server's current tool definitions (re-pin after an update)")
  .option("--include-flagged", "also accept tools the scanner flagged as suspicious")
  .action(async (name: string, opts: { includeFlagged?: boolean }) => {
    requireInitialised();
    const { hub } = openHub();
    try {
      const tools = await hub.trust(name, { includeFlagged: opts.includeFlagged === true });
      const quarantined = tools.filter((t) => t.status === "quarantined");
      console.log(`${green("✓")} pinned ${tools.length} tool definitions for ${bold(name)}`);
      if (quarantined.length > 0) {
        console.log(
          red(`  ${quarantined.length} tool(s) stay quarantined by the scanner: `) +
            quarantined.map((t) => t.name).join(", "),
        );
        console.log(dim("  Review them with `foreman mcp tools " + name + "`; accept with --include-flagged."));
      }
    } catch (err) {
      fail(err);
    } finally {
      await hub.close();
      closeDb();
    }
  });

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function printTool(t: HubTool): void {
  const icon = t.status === "available" ? green("✓") : t.status === "denied" ? dim("⊘") : red("⚠");
  const rule = t.rule ? dim(` [${t.rule}]`) : "";
  console.log(`  ${icon} ${t.name}${rule}`);
  for (const reason of t.reasons) console.log(`      ${red(reason)}`);
  for (const f of t.findings.filter((x) => x.severity === "medium")) {
    console.log(`      ${dim(`note: ${f.reason} (${f.location})`)}`);
  }
}

function printTokenReport(tools: HubTool[], config: HubConfig): void {
  const visible = tools.filter((t) => t.status === "available");
  if (visible.length === 0) return;
  const raw = estimateTokens(
    visible.map((t) => ({
      name: t.exposedName,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
      ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
    })),
  );
  const compact = estimateTokens(visible.map((t) => compactForAgent(t, config.limits.max_description_chars)));
  const lazy = estimateTokens([{ search: 1 }, { call: 1 }]) + 180;
  console.log(
    dim(
      `listing cost ≈ ${raw} tokens raw → ${compact} compacted → ~${lazy} in lazy mode ` +
        `(mode: ${config.mode}, ${visible.length} tools)`,
    ),
  );
}

function reportSecrets(config: HubConfig, name: string): void {
  const store = openSecretStore();
  const missing = missingSecrets(config, name, (n) => store.exists(n));
  closeDb();
  if (missing.length === 0) return;
  console.log(orange("  secrets needed (stored encrypted, never shown to agents):"));
  for (const s of missing) console.log(`    foreman secrets add ${s}`);
}

function openHub(): { hub: McpHub; config: HubConfig } {
  const paths = getForemanPaths();
  const config = readConfig(paths.mcpConfigPath);
  const store = openSecretStore();
  const hub = new McpHub({
    config,
    resolveSecret: (n) => (store.exists(n) ? store.get(n) : null),
    pins: new ToolPinStore(config.security.pin_tool_definitions ? paths.mcpPinsPath : null),
    oauth: hubOAuthSessions(paths, store),
  });
  return { hub, config };
}

function openSecretStore(): SecretStore {
  return new SecretStore(getDb(), loadOrCreateSecretsMasterKey());
}

function readConfig(path: string): HubConfig {
  try {
    return existsSync(path) ? loadHubConfig(path) : defaultHubConfig();
  } catch (err) {
    fail(err);
  }
}

function collectPairs(value: string, previous: Record<string, string>): Record<string, string> {
  const at = value.indexOf("=");
  if (at <= 0) throw new Error(`expected KEY=VALUE, got '${value}'`);
  return { ...previous, [value.slice(0, at)]: value.slice(at + 1) };
}

function requireInitialised(): void {
  const paths = getForemanPaths();
  if (!existsSync(paths.root)) {
    console.error(red("error: ") + `Foreman is not initialised at ${paths.root}. Run 'foreman init' first.`);
    process.exit(1);
  }
}

function fail(err: unknown): never {
  console.error(red("error: ") + describeHubError(err));
  process.exit(1);
}

/** A rejected mcp.yaml edit in words: a ZodError's message is the raw
 *  JSON array of issues (#657). Exported for tests. */
export function describeHubError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues
      .map((issue) => {
        const [top, server, ...rest] = issue.path;
        const where =
          top === "servers" && server !== undefined
            ? `server '${String(server)}'${rest.length > 0 ? ` (${rest.join(".")})` : ""}: `
            : issue.path.length > 0
              ? `${issue.path.join(".")}: `
              : "";
        return `${where}${issue.message}`;
      })
      .join("; ");
  }
  return err instanceof HubConfigEditError || err instanceof Error ? err.message : String(err);
}
