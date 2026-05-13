import { describe, expect, it, vi } from "vitest";
import {
  handleMessage,
  type McpStdioServices,
} from "../../src/cli/mcp-stdio.js";
import type { MediatorOutput } from "../../src/core/mediator.js";
import type { JSONRPCMessage } from "../../src/mcp/types.js";

function makeServices(
  decision: "allowed" | "denied",
  decidedBy = "policy:7",
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

  it("returns an empty tools list for tools/list (no in-process tools yet)", async () => {
    const out = (await handleMessage(makeServices("allowed"), "claude-code", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    } as JSONRPCMessage)) as unknown as { result: { tools: unknown[] } };
    expect(out.result.tools).toEqual([]);
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
});
