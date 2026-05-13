import { describe, expect, it, vi } from "vitest";
import {
  handleMessage,
  type McpStdioServices,
} from "../../src/cli/mcp-stdio.js";
import type {
  MediatorOutput,
  SecretGetOutput,
} from "../../src/core/mediator.js";
import type { JSONRPCMessage } from "../../src/mcp/types.js";

function makeServices(
  decision: "allowed" | "denied",
  decidedBy = "policy:7",
  secretOutput?: SecretGetOutput,
): McpStdioServices {
  const result: MediatorOutput = {
    requestId: "r1",
    decision,
    decidedBy,
    riskScore: 10,
    riskReasons: [],
    durationMs: 5,
  };
  return {
    mediator: {
      handleRequest: vi.fn(async () => result),
      handleSecretGet: vi.fn(async () => secretOutput),
    },
  } as unknown as McpStdioServices;
}

describe("mcp-stdio handleMessage", () => {
  it("responds to initialize with the protocol version + server info", async () => {
    const out = (await handleMessage(makeServices("allowed"), "claude-code", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    } as JSONRPCMessage)) as unknown as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(out.result.protocolVersion).toBe("2024-11-05");
    expect(out.result.serverInfo.name).toBe("foreman");
  });

  it("advertises the built-in secrets/get tool on tools/list", async () => {
    const out = (await handleMessage(makeServices("allowed"), "claude-code", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    } as JSONRPCMessage)) as unknown as {
      result: { tools: { name: string; inputSchema?: unknown }[] };
    };
    expect(out.result.tools.map((t) => t.name)).toContain("secrets/get");
    const tool = out.result.tools.find((t) => t.name === "secrets/get");
    expect(tool?.inputSchema).toBeDefined();
  });

  it("routes tools/call through mediator and returns success on allow", async () => {
    const services = makeServices("allowed");
    const out = (await handleMessage(services, "claude-code", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "read_file", arguments: { path: "src/auth.ts" } },
    } as JSONRPCMessage)) as unknown as {
      result: { content: { text: string }[] };
    };
    expect(services.mediator.handleRequest).toHaveBeenCalledOnce();
    expect(out.result.content[0]?.text).toMatch(/allowed by policy:7/);
  });

  it("returns a JSON-RPC error on deny with decidedBy", async () => {
    const services = makeServices("denied", "user");
    const out = (await handleMessage(services, "claude-code", {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "run_shell", arguments: {} },
    } as JSONRPCMessage)) as unknown as {
      error: { code: number; message: string };
    };
    expect(out.error.code).toBe(-32603);
    expect(out.error.message).toContain("Denied by user");
  });

  it("returns method-not-found for unknown requests with an id", async () => {
    const out = (await handleMessage(makeServices("allowed"), "claude-code", {
      jsonrpc: "2.0",
      id: 5,
      method: "who/are/you",
    } as JSONRPCMessage)) as unknown as { error: { code: number } };
    expect(out.error.code).toBe(-32601);
  });

  it("returns null for notifications (no id, no reply)", async () => {
    const out = await handleMessage(makeServices("allowed"), "claude-code", {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
    } as JSONRPCMessage);
    expect(out).toBeNull();
  });

  it("routes tools/call name=secrets/get through mediator.handleSecretGet", async () => {
    const services = makeServices("allowed", "policy:7", {
      requestId: "s1",
      decision: "allowed",
      decidedBy: "policy:3",
      value: "sk-abc",
    });
    const out = (await handleMessage(services, "hermes", {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "secrets/get", arguments: { name: "anthropic-key" } },
    } as JSONRPCMessage)) as unknown as {
      result: { content: { type: string; text: string }[] };
    };
    expect(services.mediator.handleSecretGet).toHaveBeenCalledWith({
      sourceAgent: "hermes",
      secretName: "anthropic-key",
    });
    expect(services.mediator.handleRequest).not.toHaveBeenCalled();
    expect(out.result.content[0]?.text).toBe("sk-abc");
  });

  it("returns -32603 deny for secrets/get when policy denies", async () => {
    const services = makeServices("allowed", "policy:7", {
      requestId: "s2",
      decision: "denied",
      decidedBy: "policy:cannot_access_secrets",
    });
    const out = (await handleMessage(services, "rogue", {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "secrets/get", arguments: { name: "openai-key" } },
    } as JSONRPCMessage)) as unknown as {
      error: { code: number; message: string };
    };
    expect(out.error.code).toBe(-32603);
    expect(out.error.message).toContain("policy:cannot_access_secrets");
  });

  it("returns -32602 invalid-params when secrets/get is called without args.name", async () => {
    const services = makeServices("allowed");
    const out = (await handleMessage(services, "hermes", {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "secrets/get", arguments: {} },
    } as JSONRPCMessage)) as unknown as {
      error: { code: number; message: string };
    };
    expect(out.error.code).toBe(-32602);
    expect(services.mediator.handleSecretGet).not.toHaveBeenCalled();
  });
});
