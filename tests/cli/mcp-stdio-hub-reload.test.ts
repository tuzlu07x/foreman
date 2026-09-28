import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  handleMessage,
  type McpStdioServices,
} from "../../src/cli/mcp-stdio.js";
import { McpHub } from "../../src/core/mcp-hub/hub.js";
import { ToolPinStore } from "../../src/core/mcp-hub/pins.js";
import { HubRuntime } from "../../src/core/mcp-hub/runtime.js";
import type { UpstreamClient } from "../../src/core/mcp-hub/upstream.js";
import type { MediatorOutput } from "../../src/core/mediator.js";
import type { JSONRPCMessage } from "../../src/mcp/types.js";

// =============================================================================
// mcp-stdio follows mcp.yaml / org.yaml while an agent stays connected
// (integrations plan §9): a disabled server leaves the next tools/list, a
// call approved after the server was disabled never runs, and a confirm
// tool always reaches the mediator with requireHuman.
// =============================================================================

type Rpc = {
  result?: {
    tools?: Array<{ name: string }>;
    content?: Array<{ text: string }>;
    isError?: boolean;
  };
  error?: { message: string };
};

describe("mcp-stdio with a live-reloaded hub", () => {
  let dir: string;
  let calls: string[];
  let mediatorHook: (() => void) | null;
  let handleRequest: Mock<(input: { requestId: string }) => Promise<MediatorOutput>>;
  let amendDecision: ReturnType<typeof vi.fn>;
  const mcp = () => join(dir, "mcp.yaml");
  const write = (text: string) => {
    writeFileSync(`${mcp()}.tmp`, text);
    renameSync(`${mcp()}.tmp`, mcp());
  };
  const yaml = (
    opts: { enabled?: boolean; access?: string; confirm?: boolean } = {},
  ) =>
    [
      "servers:",
      "  demo:",
      `    enabled: ${opts.enabled ?? true}`,
      "    command: node",
      ...(opts.access ? [`    access: ${opts.access}`] : []),
      "    tools:",
      "      allow: [echo]",
      ...(opts.confirm ? ["      confirm: [echo]"] : []),
      "",
    ].join("\n");

  const fakeClient = (): UpstreamClient => ({
    connect: async () => undefined,
    listTools: async () => [
      {
        name: "echo",
        description: "Echo back",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
        },
      },
    ],
    callTool: async (name, args) => {
      calls.push(name);
      return { content: [{ type: "text", text: String(args.text) }] };
    },
    close: async () => undefined,
  });

  const services = (agent = "claude-code"): McpStdioServices => {
    const runtime = new HubRuntime({
      paths: {
        mcpConfigPath: mcp(),
        mcpPinsPath: join(dir, "pins.json"),
        orgConfigPath: join(dir, "org.yaml"),
      },
      secretStore: { exists: () => false, get: () => "" } as never,
      agentId: agent,
      throttleMs: 0,
      build: (config) =>
        new McpHub({
          config,
          resolveSecret: () => null,
          pins: new ToolPinStore(null),
          clientFactory: fakeClient,
        }),
    });
    return {
      mediator: { handleRequest },
      audit: { logEvent: vi.fn(), logRequest: vi.fn(), amendDecision },
      registry: { heartbeat: vi.fn() },
      approval: {},
      commandRouter: { has: () => false },
      hubRuntime: runtime,
      hub: runtime.hub,
      hubScope: runtime.scope,
      llmConfigPath: join(dir, "llm.yaml"),
      configDir: dir,
    } as unknown as McpStdioServices;
  };
  const send = async (
    s: McpStdioServices,
    agent: string,
    method: string,
    params: unknown = {},
  ) =>
    (await handleMessage(s, agent, {
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    } as JSONRPCMessage)) as unknown as Rpc;
  const hubTools = async (s: McpStdioServices, agent = "claude-code") =>
    ((await send(s, agent, "tools/list")).result?.tools ?? [])
      .map((t) => t.name)
      .filter((n) => n.includes("__"));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-hub-reload-"));
    calls = [];
    mediatorHook = null;
    amendDecision = vi.fn();
    handleRequest = vi.fn(
      async (input: { requestId: string }): Promise<MediatorOutput> => {
        mediatorHook?.();
        return {
          requestId: input.requestId,
          decision: "allowed",
          decidedBy: "user:tui",
          riskScore: 0,
          riskReasons: [],
          riskFactors: [],
          riskBucket: "low",
          llmVerification: null,
          durationMs: 1,
        };
      },
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("advertises tools.listChanged", async () => {
    write(yaml());
    const init = (await handleMessage(services(), "claude-code", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    } as JSONRPCMessage)) as unknown as {
      result: { capabilities: { tools: { listChanged?: boolean } } };
    };
    expect(init.result.capabilities.tools.listChanged).toBe(true);
  });

  it("drops a disabled server from the next tools/list and its calls", async () => {
    write(yaml());
    const s = services();
    expect(await hubTools(s)).toEqual(["demo__echo"]);
    write(yaml({ enabled: false }));
    expect(await hubTools(s)).toEqual([]);
    const call = await send(s, "claude-code", "tools/call", {
      name: "demo__echo",
      arguments: { text: "x" },
    });
    expect(JSON.stringify(call)).not.toContain('"text":"x"');
    expect(calls).toEqual([]);
  });

  it("shows a server only to the agents and departments in its access list", async () => {
    write(yaml({ access: "{ agents: [codex] }" }));
    expect(await hubTools(services("claude-code"), "claude-code")).toEqual([]);
    expect(await hubTools(services("codex"), "codex")).toEqual(["demo__echo"]);
    write(yaml({ access: "{}" }));
    expect(await hubTools(services("codex"), "codex")).toEqual([]);
  });

  it("never runs a call approved after its server was disabled, and amends the decision", async () => {
    write(yaml());
    const s = services();
    mediatorHook = () => write(yaml({ enabled: false })); // disabled while the approval waited
    const out = await send(s, "claude-code", "tools/call", {
      name: "demo__echo",
      arguments: { text: "late" },
    });
    expect(out.result?.isError).toBe(true);
    expect(out.result?.content?.[0]?.text).toMatch(/no longer enabled/);
    expect(calls).toEqual([]);
    expect(amendDecision).toHaveBeenCalledWith(
      expect.any(String),
      "denied",
      "integration:disabled:demo",
    );
  });

  it("never runs a call approved after the agent lost access", async () => {
    write(yaml());
    const s = services();
    mediatorHook = () => write(yaml({ access: "{ agents: [codex] }" }));
    const out = await send(s, "claude-code", "tools/call", {
      name: "demo__echo",
      arguments: { text: "late" },
    });
    expect(out.result?.isError).toBe(true);
    expect(calls).toEqual([]);
    expect(amendDecision).toHaveBeenCalledWith(
      expect.any(String),
      "denied",
      expect.stringMatching(/demo/),
    );
  });

  it("sends a confirm tool to the mediator with requireHuman, even with an allow rule", async () => {
    write(yaml({ confirm: true }));
    const s = services();
    const out = await send(s, "claude-code", "tools/call", {
      name: "demo__echo",
      arguments: { text: "ok" },
    });
    const input = handleRequest.mock.calls[0]![0] as {
      requireHuman?: { factor: { rule: string } };
      policyFallback?: { effect: string };
    };
    expect(input.requireHuman?.factor.rule).toBe("mcp_confirm");
    expect(input.policyFallback?.effect).toBe("ask");
    // The (mock) person allowed it, so it ran.
    expect(out.result?.content?.[0]?.text).toBe("ok");

    write(yaml());
    await send(s, "claude-code", "tools/call", {
      name: "demo__echo",
      arguments: { text: "ok" },
    });
    expect(
      (handleRequest.mock.calls[1]![0] as { requireHuman?: unknown })
        .requireHuman,
    ).toBeUndefined();
  });
});
