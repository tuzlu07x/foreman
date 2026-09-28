import type { SecretStore } from "../secret-store.js";
import {
  referencedSecrets,
  toolRuleLevel,
  type HubConfig,
  type ServerAccess,
  type ServerConfig,
} from "../mcp-hub/config.js";
import { mcpOAuthStatus, type McpOAuthStatus } from "../mcp-hub/oauth-store.js";
import { serverFingerprint, type ToolPinStore } from "../mcp-hub/pins.js";
import { hasBlockingFinding, scanToolDefinition } from "../mcp-hub/tool-scan.js";

// =============================================================================
// Integration status — no network, read from what is already on disk
// =============================================================================
//
// mcp.yaml (enabled), the encrypted store (secrets present, OAuth session),
// and the tool pins (reviewed for the current launch fingerprint, tools the
// hub withholds, drift the last live check saw). Shared by list / show,
// enable checks and every UI.

export type IntegrationProblemKind = "needs-login" | "missing-secret" | "not-reviewed" | "withheld" | "drift";

export interface IntegrationProblem {
  kind: IntegrationProblemKind;
  detail: string;
}

/** Problems that make an enabled integration useless or unsafe to enable. */
export const BLOCKING_PROBLEMS: ReadonlySet<IntegrationProblemKind> = new Set([
  "needs-login",
  "missing-secret",
  "not-reviewed",
]);

export interface WithheldTool {
  tool: string;
  reason: string;
}

export interface IntegrationToolSummary {
  /** Pinned tool definitions. */
  total: number;
  allow: number;
  ask: number;
  confirm: number;
  deny: number;
  withheld: number;
}

export interface IntegrationStatus {
  server: string;
  integration: string;
  variant: string;
  enabled: boolean;
  /** ● enabled / ○ disabled / ⚠ attention (any problem). */
  state: "enabled" | "disabled" | "attention";
  oauth: McpOAuthStatus | null;
  missingSecrets: string[];
  /** Tool definitions are pinned for the current launch configuration.
   *  Always true when pinning is switched off in mcp.yaml. */
  reviewed: boolean;
  pinnedAt: number | null;
  withheld: WithheldTool[];
  drift: { changed: string[]; added: string[]; seenAt: number } | null;
  tools: IntegrationToolSummary | null;
  problems: IntegrationProblem[];
}

export interface IntegrationStatusDeps {
  pins: Pick<ToolPinStore, "get">;
  secrets: Pick<SecretStore, "exists" | "get">;
  security: HubConfig["security"];
  now?: number;
}

/** The launch identity pins are bound to (never includes secret values). */
export function launchFingerprint(server: Pick<ServerConfig, "command" | "args" | "url">): string {
  return serverFingerprint({
    ...(server.command ? { command: server.command } : {}),
    args: server.args,
    ...(server.url ? { url: server.url } : {}),
  });
}

export function integrationStatus(name: string, server: ServerConfig, deps: IntegrationStatusDeps): IntegrationStatus {
  const problems: IntegrationProblem[] = [];
  const missingSecrets = referencedSecrets(server).filter((s) => !deps.secrets.exists(s));
  for (const secret of missingSecrets) {
    problems.push({ kind: "missing-secret", detail: `secret '${secret}' is not in the secret store` });
  }
  let oauth: McpOAuthStatus | null = null;
  if (server.auth === "oauth") {
    oauth = mcpOAuthStatus(deps.secrets, name, server.url, deps.now);
    if (oauth.state === "needs-login") problems.push({ kind: "needs-login", detail: oauth.reason });
  }

  const pinning = deps.security.pin_tool_definitions;
  const pins = pinning ? deps.pins.get(name, launchFingerprint(server)) : null;
  const reviewed = !pinning || pins !== null;
  if (!reviewed) {
    problems.push({ kind: "not-reviewed", detail: "tool definitions have not been reviewed and pinned yet" });
  }

  const withheld: WithheldTool[] = [];
  let tools: IntegrationToolSummary | null = null;
  const drift = pins?.drift ? { changed: pins.drift.changed, added: pins.drift.added, seenAt: pins.drift.seenAt } : null;
  if (pins) {
    tools = { total: 0, allow: 0, ask: 0, confirm: 0, deny: 0, withheld: 0 };
    for (const [toolName, pinned] of Object.entries(pins.tools)) {
      tools.total++;
      const level = toolRuleLevel(server.tools, toolName) ?? "ask";
      tools[level]++;
      if (level === "deny") continue;
      if (drift?.changed.includes(toolName)) {
        withheld.push({ tool: toolName, reason: "definition changed since it was reviewed" });
      } else if (
        deps.security.quarantine_suspicious_tools &&
        !pinned.trustedDespiteFindings &&
        hasBlockingFinding(scanToolDefinition(pinned.definition))
      ) {
        withheld.push({ tool: toolName, reason: "suspicious definition (scanner)" });
      }
    }
    for (const toolName of drift?.added ?? []) {
      if (toolRuleLevel(server.tools, toolName) !== "deny") {
        withheld.push({ tool: toolName, reason: "new since the last review" });
      }
    }
    tools.withheld = withheld.length;
  }
  if (withheld.length > 0) {
    problems.push({
      kind: "withheld",
      detail: `${withheld.length} tool(s) withheld until reviewed: ${withheld.map((w) => w.tool).join(", ")}`,
    });
  }
  if (drift && (drift.changed.length > 0 || drift.added.length > 0)) {
    problems.push({ kind: "drift", detail: "the server's tools changed since the last review" });
  }

  const meta = server.integration;
  return {
    server: name,
    integration: meta?.id ?? name,
    variant: meta?.variant ?? "",
    enabled: server.enabled,
    state: problems.length > 0 ? "attention" : server.enabled ? "enabled" : "disabled",
    oauth,
    missingSecrets,
    reviewed,
    pinnedAt: pins?.pinnedAt ?? null,
    withheld,
    drift,
    tools,
    problems,
  };
}

export function blockingProblems(status: IntegrationStatus): IntegrationProblem[] {
  return status.problems.filter((p) => BLOCKING_PROBLEMS.has(p.kind));
}

/** "every verified agent", "nobody", "claude-code, codex + engineering". */
export function describeAccess(access: ServerAccess | undefined): string {
  if (!access) return "every verified agent";
  const agents = access.agents ?? [];
  const departments = access.departments ?? [];
  if (agents.length === 0 && departments.length === 0) return "nobody";
  const parts = [...agents];
  if (departments.length > 0) parts.push(`department${departments.length > 1 ? "s" : ""} ${departments.join(", ")}`);
  return parts.join(", ");
}
