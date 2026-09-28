import type { HubConfig } from "../mcp-hub/config.js";
import { McpHub, type HubTool, type McpHubOptions } from "../mcp-hub/hub.js";

// =============================================================================
// Review and test an integration from the user's side (CLI / TUI)
// =============================================================================
//
// Both run in the user's own process, on a private hub that holds only this
// one server — even while the integration is disabled, which is exactly
// when it is reviewed. No agent ever sees this hub.
//
// review: connect, list the live tools, scan them, pin them. After this the
//   integration can be enabled (IntegrationService.enable checks the pins).
// test:   connect and call the catalog's health-check tool.

export type HubFactory = (options: Pick<McpHubOptions, "config">) => McpHub;

export interface ReviewResult {
  tools: HubTool[];
  /** Tools the scanner still quarantines (pinned but withheld). */
  quarantined: HubTool[];
  /** Tools tools.deny hides from agents. */
  denied: HubTool[];
}

/** A config with only `name`, enabled, for a private review hub. */
export function soloConfig(config: HubConfig, name: string): HubConfig {
  const server = config.servers[name];
  if (!server) throw new Error(`no server named '${name}' in mcp.yaml`);
  return { ...config, servers: { [name]: { ...server, enabled: true } } };
}

export async function reviewIntegration(
  config: HubConfig,
  name: string,
  makeHub: HubFactory,
  opts: { includeFlagged?: boolean } = {},
): Promise<ReviewResult> {
  const hub = makeHub({ config: soloConfig(config, name) });
  try {
    const tools = await hub.trust(name, { includeFlagged: opts.includeFlagged === true });
    return {
      tools,
      quarantined: tools.filter((t) => t.status === "quarantined"),
      denied: tools.filter((t) => t.status === "denied"),
    };
  } finally {
    await hub.close();
  }
}

export interface HealthCheckResult {
  ok: boolean;
  tool: string;
  detail: string;
  durationMs: number;
}

/** Call the health-check tool (a read, e.g. GitHub's get_me). */
export async function testIntegration(
  config: HubConfig,
  name: string,
  healthTool: string,
  makeHub: HubFactory,
): Promise<HealthCheckResult> {
  const hub = makeHub({ config: soloConfig(config, name) });
  try {
    const resolved = await hub.resolveCall(`${name}__${healthTool}`, {});
    if (!resolved || resolved.kind !== "tool") {
      const detail = resolved?.kind === "unavailable" ? resolved.message : `'${healthTool}' is not offered`;
      return { ok: false, tool: healthTool, detail, durationMs: 0 };
    }
    const { result, durationMs } = await hub.call(resolved.tool, {});
    const text = (result.content ?? [])
      .map((c) => (c.type === "text" ? c.text : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return {
      ok: result.isError !== true,
      tool: healthTool,
      detail: text.length > 160 ? `${text.slice(0, 159)}…` : text,
      durationMs,
    };
  } catch (err) {
    return { ok: false, tool: healthTool, detail: err instanceof Error ? err.message : String(err), durationMs: 0 };
  } finally {
    await hub.close();
  }
}
