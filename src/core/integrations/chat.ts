import { IntegrationError, IntegrationNotReadyError, type IntegrationService, type IntegrationVia } from "./service.js";
import type { ConfirmationStore } from "./confirmations.js";
import { integrationServers } from "./resolve.js";
import { describeAccess } from "./status.js";

// =============================================================================
// `/integrations` and `/integration …` from chat (Telegram, Slack, Discord)
// and the TUI console
// =============================================================================
//
// Reads (list, status) run for anyone who may use the command at all,
// including an agent relaying it. Changes (enable, disable, remove) need an
// owner surface: the TUI, the Telegram approval bot in your private chat,
// or Slack / Discord from an owner id. Adding, updating and signing in stay
// on the host — credentials are never accepted in chat.

export interface IntegrationChatContext {
  service: IntegrationService | null;
  confirmations: ConfirmationStore | null;
  /** tui / telegram / slack / discord, or the relaying agent's id. */
  surface: string;
  user: string;
  /** May change integrations (see the header). */
  owner: boolean;
  /** Told about every change made from chat (the inbox). */
  notice?: (title: string) => void;
}

const MUTATING = new Set(["enable", "disable", "remove"]);
const HOST_ONLY = new Set(["add", "update", "login", "logout", "review", "test", "adopt", "rotate"]);

export async function integrationChat(args: readonly string[], ctx: IntegrationChatContext): Promise<string> {
  const [rawSub = "list", ...rest] = args;
  const sub = rawSub.toLowerCase();
  const svc = ctx.service;
  if (!svc) return "Integrations aren't available here. Use `foreman integrations` on the Foreman host.";
  if (HOST_ONLY.has(sub)) {
    return `\`integration ${sub}\` runs on the Foreman host, never in chat (credentials don't belong here): open the TUI (\`i\`) or run \`foreman integrations ${sub}${rest[0] ? ` ${rest[0]}` : ""}\`.`;
  }
  if (sub === "list") return list(svc);
  if (sub === "status" || sub === "show") return rest[0] ? status(svc, rest[0]) : "Usage: `integration status <name>`";
  if (!MUTATING.has(sub)) {
    return "Usage: `integrations` · `integration status|enable|disable|remove <name>`";
  }
  if (!ctx.owner) {
    return `Only you can ${sub} an integration — from the TUI, the Foreman approval bot, or Slack / Discord as an owner.`;
  }
  const name = rest[0];
  if (!name) return `Usage: \`integration ${sub} <name>\``;
  const via = viaOf(ctx.surface);
  const actor = { via, actor: ctx.user };
  try {
    if (sub === "enable") {
      const st = await svc.enable(name, actor);
      ctx.notice?.(`${st.server} enabled from ${label(ctx)}`);
      const withheld = st.withheld.length > 0 ? ` Withheld until reviewed: ${st.withheld.map((w) => w.tool).join(", ")}.` : "";
      return `${st.server} enabled — connected agents see it now.${withheld}`;
    }
    if (sub === "disable") {
      const resolved = svc.status(name).server;
      await svc.disable(resolved, actor);
      ctx.notice?.(`${resolved} disabled from ${label(ctx)}`);
      return `${resolved} disabled — connected agents lost it.`;
    }
    // remove: two steps with a confirmation code
    const resolved = svc.status(name).server;
    const confirmations = ctx.confirmations;
    if (!confirmations) return "Removing from chat isn't available here; use `foreman integrations remove` on the host.";
    const scope = { surface: ctx.surface, user: ctx.user, action: "remove", server: resolved };
    if (rest[1]?.toLowerCase() !== "confirm") {
      const code = confirmations.issue(scope);
      return `This removes ${resolved}, its sign-in and the credentials nothing else uses. To go ahead, send within 2 minutes:\n/integration remove ${resolved} confirm ${code}`;
    }
    if (!rest[2] || !confirmations.consume(rest[2], scope)) {
      return `That code isn't valid (wrong, used or expired). Send \`/integration remove ${resolved}\` for a new one.`;
    }
    const res = await svc.remove(resolved, actor);
    ctx.notice?.(`${resolved} removed from ${label(ctx)}`);
    return `${resolved} removed.${res.revokeUrl ? ` Revoke Foreman's access at the provider too: ${res.revokeUrl}` : ""}`;
  } catch (err) {
    if (err instanceof IntegrationNotReadyError) {
      return `${name} stays disabled: ${err.status.problems.map((p) => p.detail).join("; ")}. Finish it on the host (\`foreman integrations review ${name}\`).`;
    }
    if (err instanceof IntegrationError) return err.message;
    throw err;
  }
}

function list(svc: IntegrationService): string {
  const config = svc.config();
  const rows = integrationServers(config);
  if (rows.length === 0) return "No integrations yet. Add one on the host: `foreman integrations catalog`.";
  return rows
    .map(([name, server]) => {
      const st = svc.status(name, config);
      const icon = st.state === "attention" ? "⚠" : server.enabled ? "●" : "○";
      const tools = st.tools ? `${st.tools.total} tools` : "not reviewed";
      return `${icon} ${name} — ${server.integration!.access_level}, ${tools}, ${describeAccess(server.access)}`;
    })
    .join("\n");
}

function status(svc: IntegrationService, query: string): string {
  try {
    const st = svc.status(query);
    const server = svc.config().servers[st.server]!;
    const meta = server.integration!;
    const lines = [
      `${st.server} (${meta.id}, ${meta.variant}) — ${server.enabled ? "enabled" : "disabled"}, ${meta.access_level}`,
      `who: ${describeAccess(server.access)}`,
      // Names and presence only, never values.
      ...(Object.values(meta.secrets).length > 0
        ? [`credentials: ${Object.values(meta.secrets).map((s) => `${s} ${st.missingSecrets.includes(s) ? "missing" : "stored"}`).join(", ")}`]
        : []),
      ...(st.oauth ? [`sign-in: ${st.oauth.state}`] : []),
      st.tools ? `tools: ${st.tools.total} (ask ${st.tools.ask + st.tools.confirm}, withheld ${st.tools.withheld})` : "tools: not reviewed",
      ...st.problems.map((p) => `⚠ ${p.detail}`),
    ];
    return lines.join("\n");
  } catch (err) {
    if (err instanceof IntegrationError) return err.message;
    throw err;
  }
}

function viaOf(surface: string): IntegrationVia {
  return surface === "slack" || surface === "discord" || surface === "telegram" || surface === "tui" ? surface : "cli";
}

function label(ctx: IntegrationChatContext): string {
  const where = ctx.surface.charAt(0).toUpperCase() + ctx.surface.slice(1);
  return ctx.user ? `${where} by ${ctx.user}` : where;
}

/** Keep a reply inside the surface's message limit. */
export function clipForSurface(text: string, surface: string): string {
  const max = surface === "discord" ? 1900 : surface === "telegram" ? 3900 : 3500;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
