import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { Command } from "commander";
import { AuditLogger } from "../core/audit.js";
import { EventBus, type ForemanEventMap } from "../core/event-bus.js";
import {
  findIntegration,
  findVariant,
  loadBundledIntegrationCatalog,
  type IntegrationCatalog,
  type IntegrationEntry,
  type IntegrationVariant,
} from "../core/integrations/catalog.js";
import { integrationServers } from "../core/integrations/resolve.js";
import {
  IntegrationNotReadyError,
  IntegrationService,
  type AccessChoice,
  type IntegrationActor,
} from "../core/integrations/service.js";
import { describeAccess, type IntegrationStatus } from "../core/integrations/status.js";
import { reviewIntegration, testIntegration, type HubFactory } from "../core/integrations/verify.js";
import { hubOAuthSessions, mcpOAuthLockPath, scopeForAgent } from "../core/mcp-hub/boot.js";
import { findCatalogEntry, loadBundledMcpCatalog, type McpCatalog } from "../core/mcp-hub/catalog.js";
import { toolRuleLevel, type AccessLevelId, type HubConfig } from "../core/mcp-hub/config.js";
import { McpHub } from "../core/mcp-hub/hub.js";
import { describeMcpOAuthStatus } from "../core/mcp-hub/oauth-store.js";
import { removeMcpOAuthSession, revokeMcpOAuthTokens } from "../core/mcp-hub/oauth-session.js";
import { ToolPinStore } from "../core/mcp-hub/pins.js";
import { loadBundledRegistry } from "../core/registry-catalog.js";
import { RegistryService } from "../core/registry.js";
import { SecretStore } from "../core/secret-store.js";
import { closeDb, getDb } from "../db/client.js";
import { loadOrCreateSecretsMasterKey } from "../identity/master-key.js";
import { getForemanPaths } from "../utils/config.js";
import { bold, dim, green, orange, red } from "./colors.js";
import { describeHubError } from "./mcp-cli.js";
import {
  cliOAuthLogin,
  cliOAuthLogout,
  DEFAULT_LOGIN_TIMEOUT_MS,
  loginTimeoutSeconds,
  MAX_LOGIN_TIMEOUT_MS,
} from "./oauth-cli-shared.js";
import { readSecretValueFromStdin } from "./secrets-cli.js";

// =============================================================================
// `foreman integrations` — GitHub, GitLab, Jira/Confluence, Trello, Linear
// and Notion as managed MCP hub servers (docs/integrations.md)
// =============================================================================
//
// Every change goes through IntegrationService (mcp.yaml under its lock,
// audited as via: cli). Credentials are read from a hidden prompt or stdin,
// never from an argument. A new integration is saved disabled, signed in
// and reviewed, and only then enabled.

const CLI: IntegrationActor = { via: "cli" };

export const integrationsCommand = new Command("integrations")
  .alias("integration")
  .description("Integrations (GitHub, GitLab, Jira, Trello, Linear, Notion) — add, change, enable and remove them");

integrationsCommand
  .command("catalog")
  .description("Integrations you can add")
  .option("--json", "output JSON")
  .action((opts: { json?: boolean }) => {
    const { integrations, mcp } = catalogs();
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(integrations.integrations, null, 2)}\n`);
      return;
    }
    for (const entry of integrations.integrations) {
      const aliases = entry.aliases.length > 0 ? dim(` (${entry.aliases.join(", ")})`) : "";
      console.log(`${bold(entry.id.padEnd(10))} ${entry.name}${aliases} ${dim("·")} ${entry.description}`);
      for (const v of entry.variants) {
        const star = v.recommended ? green("★") : " ";
        const status = findCatalogEntry(mcp, v.server)?.status;
        const badge = status ? ` ${orange(status)}` : "";
        console.log(`  ${star} ${v.id.padEnd(10)} ${v.label}${badge}`);
      }
    }
    console.log("");
    console.log(dim("Add one with `foreman integrations add <id>` (★ = recommended variant)."));
  });

integrationsCommand
  .command("list")
  .description("Configured integrations and their state")
  .option("--json", "output JSON")
  .action((opts: { json?: boolean }) => {
    requireInitialised();
    withService((svc) => {
      const config = svc.config();
      const rows = integrationServers(config).map(([name, server]) => ({ name, server, status: svc.status(name, config) }));
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            rows.map((r) => ({
              name: r.name,
              integration: r.status.integration,
              variant: r.status.variant,
              enabled: r.status.enabled,
              state: r.status.state,
              access_level: r.server.integration!.access_level,
              access: r.server.access ?? null,
              tools: r.status.tools,
              problems: r.status.problems,
            })),
            null,
            2,
          )}\n`,
        );
        return;
      }
      if (rows.length === 0) {
        console.log(dim("No integrations yet. See `foreman integrations catalog`."));
        return;
      }
      for (const { name, server, status } of rows) {
        const meta = server.integration!;
        const tools = status.tools ? `${status.tools.total} tools · ${status.tools.ask + status.tools.confirm} ask` : "not reviewed";
        console.log(
          `  ${stateIcon(status)} ${bold(name.padEnd(16))} ${meta.variant} ${dim("·")} ${meta.access_level} ${dim("·")} ${tools} ${dim("·")} ${describeAccess(server.access)}`,
        );
        for (const p of status.problems) console.log(`      ${orange("⚠")} ${p.detail}`);
      }
    });
  });

integrationsCommand
  .command("show <name>")
  .description("Details: server, credentials, access per agent, tool rules, problems")
  .option("--json", "output JSON")
  .action((name: string, opts: { json?: boolean }) => {
    requireInitialised();
    withService((svc, ctx) => {
      const config = svc.config();
      const resolvedName = resolveName(svc, name);
      const server = config.servers[resolvedName]!;
      const meta = server.integration!;
      const status = svc.status(resolvedName, config);
      const agents = agentAccess(config, resolvedName, ctx.registry);
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify({ name: resolvedName, integration: meta, access: server.access ?? null, url: server.url ?? null, command: server.command ?? null, tools: server.tools, status, agents }, null, 2)}\n`,
        );
        return;
      }
      const entry = findIntegration(ctx.catalogs.integrations, meta.id);
      console.log(`${stateIcon(status)} ${bold(resolvedName)} ${dim("—")} ${entry?.name ?? meta.id} (${meta.variant})`);
      console.log(`  server        ${server.url ?? `${server.command} ${server.args.join(" ")}`}`);
      console.log(`  access level  ${meta.access_level}`);
      if (meta.products) console.log(`  products      ${meta.products.join(", ")}`);
      console.log(`  who           ${describeAccess(server.access)}`);
      for (const a of agents) console.log(`                ${a.allowed ? green("✓") : dim("·")} ${a.agent}`);
      const secrets = Object.values(meta.secrets);
      if (secrets.length > 0) {
        console.log(
          `  credentials   ${secrets.map((s) => `${s} ${status.missingSecrets.includes(s) ? red("missing") : green("✓")}`).join(", ")}`,
        );
      }
      if (status.oauth) console.log(`  sign-in       ${describeMcpOAuthStatus(resolvedName, status.oauth)}`);
      if (status.tools) {
        const t = status.tools;
        console.log(`  tools         ${t.total} · allow ${t.allow} · ask ${t.ask} · confirm ${t.confirm} · deny ${t.deny} · withheld ${t.withheld}`);
      } else {
        console.log(`  tools         ${orange("not reviewed")} — foreman integrations review ${resolvedName}`);
      }
      const overrides = Object.entries(meta.tool_overrides).filter(([, v]) => Array.isArray(v) && v.length > 0);
      for (const [level, list] of overrides) console.log(`  override      ${level}: ${(list as string[]).join(", ")}`);
      for (const w of status.withheld) console.log(`  ${orange("⚠")} ${w.tool}: ${w.reason}`);
      for (const p of status.problems.filter((x) => x.kind !== "withheld")) console.log(`  ${orange("⚠")} ${p.detail}`);
      console.log(dim(`  updated ${meta.updated_at}`));
    });
  });

integrationsCommand
  .command("add <id>")
  .description("Add an integration: credentials or sign-in, review its tools, then enable it")
  .option("--variant <variant>", "which variant (see `foreman integrations catalog`)")
  .option("--name <name>", "server name, e.g. github-work for a second account")
  .option("--read-only", "read-only access (the default)")
  .option("--read-write", "read-write access")
  .option("--param <KEY=VALUE>", "a parameter, e.g. host=gitlab.example.com (repeatable)", collectPairs, {})
  .option("--products <ids>", "only these products (comma-separated, e.g. jira)")
  .option("--agents <ids>", "agents that may use it (comma-separated)")
  .option("--departments <ids>", "org.yaml departments whose members may use it (comma-separated)")
  .option("--all-agents", "every verified agent may use it")
  .option("--token-stdin", "read the credential from stdin instead of a prompt (one line per credential)")
  .option("--username <user>", "user name for a user-and-token variant (the token comes from the prompt or stdin)")
  .option("--no-login", "save it without signing in now (OAuth variants)")
  .option("--no-review", "save it without connecting to review the tools")
  .option("--disabled", "leave it disabled after review")
  .action(async (id: string, opts: AddOptions) => {
    requireInitialised();
    await withServiceAsync(async (svc, ctx) => {
      const entry = findIntegration(ctx.catalogs.integrations, id);
      if (!entry) throw new Error(`no integration '${id}' — see \`foreman integrations catalog\``);
      const variant = findVariant(entry, opts.variant);
      if (!variant) throw new Error(`${entry.name} has no variant '${opts.variant}' (${entry.variants.map((v) => v.id).join(", ")})`);
      const server = findCatalogEntry(ctx.catalogs.mcp, variant.server)!;
      const interactive = process.stdin.isTTY === true && !opts.tokenStdin;

      const params = { ...opts.param };
      for (const p of server.user_params) {
        if (params[p.name] !== undefined) continue;
        if (interactive) params[p.name] = (await ask(`${p.label} [${p.default ?? p.example}]: `)) || (p.default ?? "");
      }
      const access = await accessChoice(opts, entry, ctx.registry, interactive);
      const accessLevel = levelFrom(opts);

      console.log(`${bold(entry.name)} — ${variant.label}`);
      // A second account (github-work) gets its own secrets (github-pat-work).
      const secretNames = accountSecretNames(entry, variant, opts.name);
      const creds = await readCredentials(variant, ctx.store, opts, secretNames);
      const added = await svc.add(
        {
          id: entry.id,
          variant: variant.id,
          ...(opts.name ? { name: opts.name } : {}),
          ...(secretNames ? { secretNames } : {}),
          ...(accessLevel ? { accessLevel } : {}),
          access,
          params,
          ...(opts.products ? { products: splitList(opts.products) } : {}),
          ...creds,
        },
        CLI,
      );
      console.log(`${green("✓")} saved ${bold(added.name)} (disabled) — ${describeAccess(added.server.access)}`);

      if (variant.auth.kind === "oauth") {
        if (!opts.login) {
          console.log(dim(`  sign in later: foreman integrations login ${added.name}`));
          return;
        }
        try {
          await cliOAuthLogin(ctx.paths, ctx.store, added.name, added.server.url!, {
            browser: true,
            timeoutSeconds: DEFAULT_LOGIN_TIMEOUT_MS / 1000,
          });
          svc.record("integration:login", added.name, CLI);
        } catch (err) {
          console.log(`${orange("!")} sign-in did not finish: ${describeHubError(err)}`);
          console.log(dim(`  it stays disabled; retry with: foreman integrations login ${added.name}`));
          return;
        }
      }
      if (!opts.review) {
        console.log(dim(`  review its tools, then enable it: foreman integrations review ${added.name}`));
        return;
      }
      if (!(await runReview(svc, ctx, added.name, false))) return;
      if (opts.disabled) {
        console.log(dim(`  enable it with: foreman integrations enable ${added.name}`));
        return;
      }
      await enableAndReport(svc, added.name);
    });
  });

integrationsCommand
  .command("update <name>")
  .description("Change access level, who can use it, products, params, variant, a tool rule, or rotate a credential")
  .option("--read-only", "read-only access")
  .option("--read-write", "read-write access")
  .option("--agents <ids>", "agents that may use it (comma-separated; replaces the list)")
  .option("--departments <ids>", "departments whose members may use it (comma-separated)")
  .option("--all-agents", "every verified agent may use it")
  .option("--products <ids>", "only these products (comma-separated); `all` for every product")
  .option("--param <KEY=VALUE>", "change a parameter (repeatable)", collectPairs, {})
  .option("--variant <variant>", "switch variant (needs a new review)")
  .option("--tool <TOOL=RULE>", "per-tool rule: allow, ask, confirm, deny or default (repeatable)", collectList, [])
  .option("--rotate <slot>", "replace a stored credential (prompt or --token-stdin)")
  .option("--token-stdin", "read the new credential from stdin")
  .action(async (name: string, opts: UpdateOptions) => {
    requireInitialised();
    await withServiceAsync(async (svc) => {
      const resolved = resolveName(svc, name);
      if (opts.rotate) {
        const value = (await readSecretValueFromStdin(`New value for ${opts.rotate}: `)).trim();
        const stored = await svc.rotateSecret(resolved, opts.rotate, value, CLI);
        console.log(`${green("✓")} rotated ${bold(stored)} — the hub uses it on its next connection`);
      }
      const accessGiven = opts.agents !== undefined || opts.departments !== undefined || opts.allAgents === true;
      const tools = opts.tool.map(parseToolRule);
      const level = levelFrom(opts);
      const changes = {
        ...(level ? { accessLevel: level } : {}),
        ...(accessGiven ? { access: accessFromFlags(opts) } : {}),
        ...(opts.products ? { products: opts.products === "all" ? null : splitList(opts.products) } : {}),
        ...(Object.keys(opts.param).length > 0 ? { params: opts.param } : {}),
        ...(opts.variant ? { variant: opts.variant } : {}),
      };
      if (Object.keys(changes).length === 0 && tools.length === 0) {
        if (!opts.rotate) console.log(dim("nothing to change — see `foreman integrations update --help`"));
        return;
      }
      // One audited update per tool rule, after the other changes.
      let res = await svc.update(resolved, changes, CLI);
      const needsReview = res.needsReview;
      const ignored = [...res.ignoredOverrides];
      for (const toolOverride of tools) {
        res = await svc.update(resolved, { toolOverride }, CLI);
        ignored.push(...res.ignoredOverrides.filter((o) => o.tool === toolOverride.tool));
      }
      res = { ...res, ignoredOverrides: ignored, needsReview: needsReview || res.needsReview };
      console.log(`${green("✓")} updated ${bold(res.name)} — ${res.server.integration!.access_level}, ${describeAccess(res.server.access)}`);
      for (const o of new Map(res.ignoredOverrides.map((x) => [x.tool, x])).values()) {
        console.log(`  ${orange("!")} ${o.tool}: your '${o.wanted}' has no effect — the catalog's '${o.effective}' is stronger`);
      }
      if (res.needsReview) {
        console.log(`  ${orange("!")} what the hub launches changed: it is disabled until you review it again`);
        console.log(dim(`    foreman integrations review ${res.name}`));
      }
    });
  });

integrationsCommand
  .command("enable <name>")
  .description("Enable (refused until credentials, sign-in and review are done)")
  .option("--force", "enable even though it is not ready")
  .action(async (name: string, opts: { force?: boolean }) => {
    requireInitialised();
    await withServiceAsync(async (svc) => enableAndReport(svc, resolveName(svc, name), opts.force === true));
  });

integrationsCommand
  .command("disable <name>")
  .description("Disable — connected agents lose it at once")
  .action(async (name: string) => {
    requireInitialised();
    await withServiceAsync(async (svc) => {
      const resolved = resolveName(svc, name);
      await svc.disable(resolved, CLI);
      console.log(`${green("✓")} ${bold(resolved)} disabled`);
    });
  });

integrationsCommand
  .command("remove <name>")
  .description("Remove an integration, its pins, sign-in and the credentials nothing else uses")
  .option("--keep-secrets", "keep its credentials in the secret store")
  .option("--yes", "don't ask")
  .action(async (name: string, opts: { keepSecrets?: boolean; yes?: boolean }) => {
    requireInitialised();
    await withServiceAsync(async (svc) => {
      const resolved = resolveName(svc, name);
      if (!opts.yes) {
        if (!process.stdin.isTTY) throw new Error("pass --yes to remove without a terminal");
        const answer = await ask(`Remove ${bold(resolved)}${opts.keepSecrets ? "" : " and its credentials"}? [y/N] `);
        if (!/^y(es)?$/i.test(answer.trim())) {
          console.log(dim("kept"));
          return;
        }
      }
      const res = await svc.remove(resolved, CLI, { keepSecrets: opts.keepSecrets === true });
      console.log(`${green("✓")} removed ${bold(res.name)}`);
      if (res.removedSecrets.length > 0) console.log(dim(`  deleted: ${res.removedSecrets.join(", ")}`));
      if (res.keptSecrets.length > 0) console.log(dim(`  kept: ${res.keptSecrets.join(", ")}`));
      if (res.oauthSessionRemoved) console.log(dim("  signed out"));
      if (res.revokeUrl) console.log(`  revoke Foreman's access at the provider too: ${res.revokeUrl}`);
    });
  });

integrationsCommand
  .command("login <name>")
  .description("Sign in to an OAuth integration in your browser")
  .option("--scope <scopes>", "space-separated scopes to request")
  .option("--no-browser", "only print the URL")
  .option("--timeout <seconds>", `how long to wait (max ${MAX_LOGIN_TIMEOUT_MS / 1000})`, String(DEFAULT_LOGIN_TIMEOUT_MS / 1000))
  .action(async (name: string, opts: { scope?: string; browser: boolean; timeout: string }) => {
    requireInitialised();
    await withServiceAsync(async (svc, ctx) => {
      const resolved = resolveName(svc, name);
      const server = svc.config().servers[resolved]!;
      if (server.auth !== "oauth" || !server.url) throw new Error(`${resolved} signs in with a token, not a browser`);
      await cliOAuthLogin(ctx.paths, ctx.store, resolved, server.url, {
        ...(opts.scope ? { scope: opts.scope } : {}),
        browser: opts.browser,
        timeoutSeconds: loginTimeoutSeconds(opts.timeout),
      });
      svc.record("integration:login", resolved, CLI);
      if (!server.enabled) console.log(dim(`  next: foreman integrations review ${resolved}`));
    });
  });

integrationsCommand
  .command("logout <name>")
  .description("Delete the stored sign-in (and revoke it at the provider when it can)")
  .action(async (name: string) => {
    requireInitialised();
    await withServiceAsync(async (svc, ctx) => {
      const resolved = resolveName(svc, name);
      if (await cliOAuthLogout(ctx.paths, ctx.store, resolved)) svc.record("integration:logout", resolved, CLI);
    });
  });

integrationsCommand
  .command("review <name>")
  .description("Connect, scan and pin the tools (needed before enabling, and after a change)")
  .option("--include-flagged", "also accept tools the scanner flagged")
  .action(async (name: string, opts: { includeFlagged?: boolean }) => {
    requireInitialised();
    await withServiceAsync(async (svc, ctx) => {
      const resolved = resolveName(svc, name);
      if (await runReview(svc, ctx, resolved, opts.includeFlagged === true)) {
        if (!svc.config().servers[resolved]!.enabled) console.log(dim(`  enable it with: foreman integrations enable ${resolved}`));
      }
    });
  });

integrationsCommand
  .command("test <name>")
  .description("Connect and call the integration's health check")
  .action(async (name: string) => {
    requireInitialised();
    await withServiceAsync(async (svc, ctx) => {
      const resolved = resolveName(svc, name);
      const config = svc.config();
      const meta = config.servers[resolved]!.integration!;
      const entry = findIntegration(ctx.catalogs.integrations, meta.id);
      const variant = entry ? findVariant(entry, meta.variant) : null;
      const tool = variant?.health_check?.tool ?? entry?.health_check?.tool;
      if (!tool) throw new Error(`${resolved} has no health check; try \`foreman integrations review ${resolved}\``);
      const res = await testIntegration(config, resolved, tool, ctx.makeHub);
      svc.record("integration:tested", resolved, CLI, { ok: res.ok, tool });
      if (res.ok) console.log(`${green("✓")} ${bold(resolved)}: ${tool} answered in ${res.durationMs} ms ${dim(res.detail)}`);
      else {
        console.log(`${red("✗")} ${bold(resolved)}: ${tool} failed — ${res.detail}`);
        process.exitCode = 1;
      }
    });
  });

integrationsCommand
  .command("adopt <server>")
  .description("Manage a server added with `foreman mcp add` as an integration")
  .requiredOption("--id <integration>", "which integration it is (e.g. github)")
  .option("--variant <variant>", "variant, when it can't be told from the server")
  .option("--read-only", "read-only access (the default)")
  .option("--read-write", "read-write access")
  .option("--agents <ids>", "agents that may use it (comma-separated)")
  .option("--departments <ids>", "departments whose members may use it (comma-separated)")
  .option("--all-agents", "every verified agent may use it")
  .action(async (serverName: string, opts: AdoptOptions) => {
    requireInitialised();
    await withServiceAsync(async (svc, ctx) => {
      const entry = findIntegration(ctx.catalogs.integrations, opts.id);
      if (!entry) throw new Error(`no integration '${opts.id}'`);
      const access = await accessChoice(opts, entry, ctx.registry, process.stdin.isTTY === true);
      const level = levelFrom(opts);
      const res = await svc.adopt(
        serverName,
        { id: entry.id, ...(opts.variant ? { variant: opts.variant } : {}), ...(level ? { accessLevel: level } : {}), access },
        CLI,
      );
      console.log(`${green("✓")} ${bold(res.name)} is now a ${entry.name} integration — ${describeAccess(res.server.access)}`);
      if (res.needsReview) console.log(`  ${orange("!")} disabled until reviewed: foreman integrations review ${res.name}`);
    });
  });

// -----------------------------------------------------------------------------
// flows
// -----------------------------------------------------------------------------

async function runReview(svc: IntegrationService, ctx: Ctx, name: string, includeFlagged: boolean): Promise<boolean> {
  console.log(dim(`Connecting to ${name} to review its tools…`));
  try {
    const res = await reviewIntegration(svc.config(), name, ctx.makeHub, { includeFlagged });
    svc.record("integration:reviewed", name, CLI, {
      tools: res.tools.length,
      quarantined: res.quarantined.map((t) => t.name),
      denied: res.denied.length,
    });
    const config = svc.config().servers[name]!;
    const byLevel = { allow: 0, ask: 0, confirm: 0, deny: 0 };
    for (const t of res.tools) byLevel[toolRuleLevel(config.tools, t.name) ?? "ask"]++;
    console.log(
      `${green("✓")} reviewed and pinned ${res.tools.length} tools — allow ${byLevel.allow}, ask ${byLevel.ask}, confirm ${byLevel.confirm}, deny ${byLevel.deny}`,
    );
    if (res.quarantined.length > 0) {
      console.log(`  ${orange("!")} withheld by the scanner: ${res.quarantined.map((t) => t.name).join(", ")}`);
      console.log(dim(`    look at them with \`foreman mcp tools ${name}\`; accept with --include-flagged`));
    }
    return true;
  } catch (err) {
    console.log(`${red("✗")} could not review ${name}: ${describeHubError(err)}`);
    console.log(dim(`  it stays disabled; fix the credential or sign-in, then: foreman integrations review ${name}`));
    process.exitCode = 1;
    return false;
  }
}

async function enableAndReport(svc: IntegrationService, name: string, force = false): Promise<void> {
  try {
    const status = await svc.enable(name, CLI, { force });
    console.log(`${green("✓")} ${bold(name)} enabled — connected agents see it at once`);
    for (const w of status.withheld) console.log(`  ${orange("!")} withheld: ${w.tool} (${w.reason})`);
  } catch (err) {
    if (!(err instanceof IntegrationNotReadyError)) throw err;
    console.log(`${orange("!")} ${name} stays disabled:`);
    for (const p of err.status.problems) console.log(`    ${p.detail}`);
    process.exitCode = 1;
  }
}

/** Store names for a second account's secrets: slot + the name's suffix
 *  (github-work → github-pat-work). Undefined for the first account. */
function accountSecretNames(
  entry: IntegrationEntry,
  variant: IntegrationVariant,
  name: string | undefined,
): Record<string, string> | undefined {
  const server = name?.trim().toLowerCase();
  if (!server || server === entry.id) return undefined;
  const suffix = server.startsWith(`${entry.id}-`) ? server.slice(entry.id.length + 1) : server;
  const slots =
    variant.auth.kind === "secrets"
      ? variant.auth.fields.map((f) => f.secret)
      : variant.auth.kind === "basic"
        ? [variant.auth.secret]
        : [];
  if (slots.length === 0) return undefined;
  return Object.fromEntries(slots.map((slot) => [slot, `${slot}-${suffix}`]));
}

async function readCredentials(
  variant: IntegrationVariant,
  store: SecretStore,
  opts: AddOptions,
  secretNames: Record<string, string> | undefined,
): Promise<{ credentials?: Record<string, string>; basicAuth?: { username: string; password: string } }> {
  const auth = variant.auth;
  if (auth.kind === "none" || auth.kind === "oauth") return {};
  const stdinLines = opts.tokenStdin ? (await readSecretValueFromStdin("")).split(/\r?\n/).filter((l) => l.length > 0) : [];
  const next = async (prompt: string): Promise<string> => {
    if (opts.tokenStdin) {
      const value = stdinLines.shift();
      if (value === undefined) throw new Error("not enough lines on stdin for the credentials");
      return value.trim();
    }
    if (!process.stdin.isTTY) throw new Error("no terminal to prompt in — pass the credential with --token-stdin");
    return (await readSecretValueFromStdin(prompt)).trim();
  };
  if (auth.kind === "basic") {
    console.log(dim(`  ${auth.setup_steps.join("\n  ")}`));
    console.log(dim(`  get it at ${auth.where_to_get}`));
    const username = opts.username ?? (process.stdin.isTTY ? (await ask(`${auth.username_label}: `)).trim() : "");
    if (!username) throw new Error(`pass --username (${auth.username_label})`);
    return { basicAuth: { username, password: await next(`${auth.password_label} (hidden): `) } };
  }
  const credentials: Record<string, string> = {};
  for (const field of auth.fields) {
    const stored = secretNames?.[field.secret] ?? field.secret;
    if (!opts.tokenStdin && store.exists(stored)) {
      console.log(dim(`  using the stored ${field.label} (${stored})`));
      continue;
    }
    console.log(dim(`  ${field.label}: ${field.format_hint} — ${field.where_to_get}`));
    credentials[field.secret] = await next(`${field.label} (hidden): `);
  }
  return Object.keys(credentials).length > 0 ? { credentials } : {};
}

async function accessChoice(
  opts: AccessFlags,
  entry: IntegrationEntry,
  registry: RegistryService,
  interactive: boolean,
): Promise<AccessChoice> {
  if (opts.agents !== undefined || opts.departments !== undefined || opts.allAgents) return accessFromFlags(opts);
  if (!interactive) throw new Error("say who may use it: --agents <ids>, --departments <ids> or --all-agents");
  const registered = registry.list().map((a) => a.id);
  const suggested = entry.used_by_agents.filter((a) => registered.includes(a));
  const def = (suggested.length > 0 ? suggested : registered).join(",");
  console.log(dim(`  registered agents: ${registered.join(", ") || "none"}`));
  const answer = (await ask(`Which agents may use ${entry.name}? (comma-separated, or 'all') [${def || "all"}]: `)).trim();
  const value = answer || def || "all";
  return value === "all" ? "all" : { agents: splitList(value) };
}

function accessFromFlags(opts: AccessFlags): AccessChoice {
  if (opts.allAgents) {
    if (opts.agents !== undefined || opts.departments !== undefined) {
      throw new Error("--all-agents can't be combined with --agents or --departments");
    }
    return "all";
  }
  return {
    ...(opts.agents !== undefined ? { agents: splitList(opts.agents) } : {}),
    ...(opts.departments !== undefined ? { departments: splitList(opts.departments) } : {}),
  };
}

function agentAccess(config: HubConfig, name: string, registry: RegistryService): Array<{ agent: string; allowed: boolean }> {
  const orgPath = getForemanPaths().orgConfigPath;
  return registry.list().map((a) => ({
    agent: a.id,
    allowed: scopeForAgent(orgPath, a.id, () => undefined, config).allowedServers?.has(name) === true,
  }));
}

// -----------------------------------------------------------------------------
// plumbing
// -----------------------------------------------------------------------------

interface AccessFlags {
  agents?: string;
  departments?: string;
  allAgents?: boolean;
}
interface LevelFlags {
  readOnly?: boolean;
  readWrite?: boolean;
}
interface AddOptions extends AccessFlags, LevelFlags {
  variant?: string;
  name?: string;
  param: Record<string, string>;
  products?: string;
  tokenStdin?: boolean;
  username?: string;
  login: boolean;
  review: boolean;
  disabled?: boolean;
}
interface UpdateOptions extends AccessFlags, LevelFlags {
  products?: string;
  param: Record<string, string>;
  variant?: string;
  tool: string[];
  rotate?: string;
  tokenStdin?: boolean;
}
interface AdoptOptions extends AccessFlags, LevelFlags {
  id: string;
  variant?: string;
}

interface Ctx {
  paths: ReturnType<typeof getForemanPaths>;
  store: SecretStore;
  registry: RegistryService;
  catalogs: { mcp: McpCatalog; integrations: IntegrationCatalog };
  makeHub: HubFactory;
}

function levelFrom(opts: LevelFlags): AccessLevelId | undefined {
  if (opts.readOnly && opts.readWrite) throw new Error("--read-only and --read-write together");
  return opts.readWrite ? "read-write" : opts.readOnly ? "read-only" : undefined;
}

function catalogs(): { mcp: McpCatalog; integrations: IntegrationCatalog } {
  const mcp = loadBundledMcpCatalog();
  const integrations = loadBundledIntegrationCatalog({
    mcp,
    agentIds: new Set(loadBundledRegistry().agents.map((a) => a.id)),
  });
  return { mcp, integrations };
}

function openContext(): { svc: IntegrationService; ctx: Ctx; audit: AuditLogger } {
  const paths = getForemanPaths();
  const db = getDb();
  const bus = new EventBus<ForemanEventMap>();
  const store = new SecretStore(db, loadOrCreateSecretsMasterKey());
  const audit = new AuditLogger(db, bus);
  const cats = catalogs();
  const pins = new ToolPinStore(paths.mcpPinsPath);
  const svc = new IntegrationService({
    paths,
    mcpCatalog: cats.mcp,
    integrationCatalog: cats.integrations,
    secrets: store,
    pins,
    audit,
    removeOAuthSession: async (server) => {
      const removed = await removeMcpOAuthSession(store, server, mcpOAuthLockPath(paths, server));
      if (removed.record) await revokeMcpOAuthTokens(removed.record).catch(() => undefined);
      return removed.removed;
    },
  });
  const makeHub: HubFactory = ({ config }) =>
    new McpHub({
      config,
      resolveSecret: (n) => (store.exists(n) ? store.get(n) : null),
      pins: new ToolPinStore(config.security.pin_tool_definitions ? paths.mcpPinsPath : null),
      oauth: hubOAuthSessions(paths, store),
    });
  return { svc, audit, ctx: { paths, store, registry: new RegistryService(db, bus), catalogs: cats, makeHub } };
}

function withService(fn: (svc: IntegrationService, ctx: Ctx) => void): void {
  const { svc, ctx, audit } = openContext();
  try {
    fn(svc, ctx);
  } catch (err) {
    fail(err);
  } finally {
    audit.dispose();
    closeDb();
  }
}

async function withServiceAsync(fn: (svc: IntegrationService, ctx: Ctx) => Promise<void>): Promise<void> {
  const { svc, ctx, audit } = openContext();
  try {
    await fn(svc, ctx);
  } catch (err) {
    audit.dispose();
    closeDb();
    fail(err);
  }
  audit.dispose();
  closeDb();
}

function resolveName(svc: IntegrationService, query: string): string {
  // status() resolves ids and aliases and throws a readable error.
  return svc.status(query).server;
}

function stateIcon(status: IntegrationStatus): string {
  return status.state === "attention" ? orange("⚠") : status.enabled ? green("●") : dim("○");
}

function parseToolRule(raw: string): { tool: string; choice: "allow" | "ask" | "confirm" | "deny" | "default" } {
  const at = raw.lastIndexOf("=");
  const tool = raw.slice(0, at);
  const choice = raw.slice(at + 1);
  if (at <= 0 || !["allow", "ask", "confirm", "deny", "default"].includes(choice)) {
    throw new Error("--tool expects TOOL=allow|ask|confirm|deny|default");
  }
  return { tool, choice: choice as "allow" | "ask" | "confirm" | "deny" | "default" };
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function collectList(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function collectPairs(value: string, previous: Record<string, string>): Record<string, string> {
  const at = value.indexOf("=");
  if (at <= 0) throw new Error(`expected KEY=VALUE, got '${value}'`);
  return { ...previous, [value.slice(0, at)]: value.slice(at + 1) };
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.on("close", () => resolve(""));
  });
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

