import { existsSync } from "node:fs";
import { Command } from "commander";
import { BusApprovalService, type ApprovalService } from "../core/approval.js";
import { AuditLogger } from "../core/audit.js";
import { bus } from "../core/event-bus.js";
import { MediatorService } from "../core/mediator.js";
import { PolicyEngine } from "../core/policy-engine.js";
import { RegistryService } from "../core/registry.js";
import { RiskScorer } from "../core/risk-scorer.js";
import { SessionManager } from "../core/session.js";
import { closeDb, getDb } from "../db/client.js";
import { createDecoder, encodeMessage } from "../mcp/framing.js";
import type { JSONRPCMessage } from "../mcp/types.js";
import { getForemanPaths } from "../utils/config.js";
import { red } from "./colors.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "foreman";
const SERVER_VERSION = "0.1.0-pre";

export const mcpStdioCommand = new Command("mcp-stdio")
  .description(
    "Serve as an MCP server over stdio so agents can route through Foreman",
  )
  .option(
    "-s, --source <id>",
    "agent id recorded as the source on every call",
    "mcp-client",
  )
  .action(async (options: { source: string }) => {
    const paths = getForemanPaths();
    if (!existsSync(paths.root) || !existsSync(paths.identityPath)) {
      process.stderr.write(
        red("error: ") +
          `Foreman is not initialised at ${paths.root}. Run 'foreman init' first.\n`,
      );
      process.exit(1);
    }
    const services = bootServices();
    autoRegisterSource(services.registry, options.source);
    runMcpLoop(services, options.source);
  });

interface Services {
  registry: RegistryService;
  policy: PolicyEngine;
  risk: RiskScorer;
  approval: ApprovalService;
  mediator: MediatorService;
  sessionManager: SessionManager;
  audit: AuditLogger;
}

function bootServices(): Services {
  const db = getDb();
  const registry = new RegistryService(db, bus);
  const audit = new AuditLogger(db, bus);
  const approval = new BusApprovalService({ bus, timeoutMs: 60_000 });
  const policy = new PolicyEngine(db, bus);
  const paths = getForemanPaths();
  if (existsSync(paths.policyPath)) policy.loadFromYaml(paths.policyPath);
  const risk = new RiskScorer(db);
  const sessionManager = new SessionManager(db, { bus });
  const mediator = new MediatorService({
    registry,
    policy,
    risk,
    approval,
    sessionManager,
    db,
    bus,
  });
  return { registry, policy, risk, approval, mediator, sessionManager, audit };
}

function autoRegisterSource(
  registry: RegistryService,
  sourceAgent: string,
): void {
  if (registry.get(sourceAgent)) return;
  registry.register({
    id: sourceAgent,
    displayName: sourceAgent,
    transport: "stdio",
  });
}

function runMcpLoop(services: Services, sourceAgent: string): void {
  const decoder = createDecoder();
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", async (chunk) => {
    const { messages } = decoder.push(chunk);
    for (const message of messages) {
      const response = await handleMessage(services, sourceAgent, message);
      if (response) process.stdout.write(encodeMessage(response));
    }
  });
  process.stdin.on("end", () => {
    cleanup(services);
    process.exit(0);
  });
  const shutdown = (): void => {
    cleanup(services);
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function cleanup(services: Services): void {
  services.audit.dispose();
  closeDb();
}

export async function handleMessage(
  services: Services,
  sourceAgent: string,
  msg: JSONRPCMessage,
): Promise<JSONRPCMessage | null> {
  const method = "method" in msg ? msg.method : null;
  const id = "id" in msg ? msg.id : undefined;

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === "tools/list") {
    return reply(id, { tools: [] });
  }
  if (method === "tools/call") {
    const params = (msg as { params?: { name?: string } }).params;
    const toolName = params?.name;
    const result = await services.mediator.handleRequest({
      sourceAgent,
      targetTool: toolName,
      message: msg,
    });
    if (result.decision === "allowed") {
      return reply(id, {
        content: [
          {
            type: "text",
            text: `(foreman) ${toolName ?? "request"} allowed by ${result.decidedBy}`,
          },
        ],
      });
    }
    return replyError(id, -32603, `Denied by ${result.decidedBy}`);
  }
  if (id !== undefined) {
    return replyError(id, -32601, `Method not found: ${method ?? "(unknown)"}`);
  }
  return null;
}

function reply(
  id: string | number | undefined,
  result: unknown,
): JSONRPCMessage | null {
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, result } as JSONRPCMessage;
}

function replyError(
  id: string | number | undefined,
  code: number,
  message: string,
): JSONRPCMessage | null {
  if (id === undefined) return null;
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  } as JSONRPCMessage;
}

export type { Services as McpStdioServices };
