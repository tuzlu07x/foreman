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
  submitApprovalResult: {
    ok: boolean;
    error?: string;
  } = { ok: true },
  commandResult: { ok: boolean; text: string; errorCode?: string } = {
    ok: true,
    text: "stub-router-response",
  },
): McpStdioServices {
  const result: MediatorOutput = {
    requestId: "r1",
    decision,
    decidedBy,
    riskScore: 10,
    riskReasons: [],
    riskFactors: [],
    riskBucket: "low",
    llmVerification: null,
    durationMs: 5,
  };
  return {
    mediator: {
      handleRequest: vi.fn(async () => result),
      handleSecretGet: vi.fn(async () => secretOutput),
    },
    approval: {
      submitFromAgent: vi.fn(async () => submitApprovalResult),
    },
    commandRouter: {
      dispatch: vi.fn(async () => commandResult),
    },
    audit: {
      logEvent: vi.fn(),
      logRequest: vi.fn(),
    },
    llmConfigPath: "/tmp/test-llm.yaml",
    configDir: "/tmp/test-config",
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

  // #406 — Agent-routed approval relay. Agent sees /approve <id> from the
  // user, calls submit_approval, Foreman emits the bus event to unblock
  // the original mediator request. No Telegram polling involved.
  describe("submit_approval tool (#406)", () => {
    it("advertises submit_approval on tools/list", async () => {
      const out = (await handleMessage(makeServices("allowed"), "hermes", {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/list",
      } as JSONRPCMessage)) as unknown as {
        result: { tools: { name: string }[] };
      };
      const names = out.result.tools.map((t) => t.name);
      expect(names).toContain("submit_approval");
    });

    it("forwards the approval id + decision + sourceAgent to approval.submitFromAgent", async () => {
      const services = makeServices("allowed");
      const out = (await handleMessage(services, "hermes", {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "submit_approval",
          arguments: {
            approval_id: "abc123",
            decision: "allow",
            remember: false,
          },
        },
      } as JSONRPCMessage)) as unknown as {
        result: { content: { text: string }[] };
      };
      expect(services.approval.submitFromAgent).toHaveBeenCalledWith({
        approvalId: "abc123",
        decision: "allow",
        remember: false,
        sourceAgent: "hermes",
      });
      expect(out.result.content[0]?.text).toMatch(/Submitted.*abc123.*allow/);
    });

    it("flags remember=true for /approve_remember and /deny_remember commands", async () => {
      const services = makeServices("allowed");
      await handleMessage(services, "openclaw", {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: {
          name: "submit_approval",
          arguments: {
            approval_id: "xyz789",
            decision: "deny",
            remember: true,
          },
        },
      } as JSONRPCMessage);
      expect(services.approval.submitFromAgent).toHaveBeenCalledWith({
        approvalId: "xyz789",
        decision: "deny",
        remember: true,
        sourceAgent: "openclaw",
      });
    });

    it("rejects submit_approval without approval_id (params)", async () => {
      const out = (await handleMessage(makeServices("allowed"), "hermes", {
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: { name: "submit_approval", arguments: { decision: "allow" } },
      } as JSONRPCMessage)) as unknown as {
        error: { code: number; message: string };
      };
      expect(out.error.code).toBe(-32602);
      expect(out.error.message).toMatch(/approval_id/);
    });

    it("rejects submit_approval with decision other than allow|deny", async () => {
      const out = (await handleMessage(makeServices("allowed"), "hermes", {
        jsonrpc: "2.0",
        id: 14,
        method: "tools/call",
        params: {
          name: "submit_approval",
          arguments: { approval_id: "abc", decision: "maybe" },
        },
      } as JSONRPCMessage)) as unknown as {
        error: { code: number; message: string };
      };
      expect(out.error.code).toBe(-32602);
      expect(out.error.message).toMatch(/decision/);
    });

    it("returns isError true with the submitFromAgent error text on validation failure", async () => {
      const services = makeServices("allowed", "policy:7", undefined, {
        ok: false,
        error: "approval missing-id not found",
      });
      const out = (await handleMessage(services, "hermes", {
        jsonrpc: "2.0",
        id: 15,
        method: "tools/call",
        params: {
          name: "submit_approval",
          arguments: { approval_id: "missing-id", decision: "allow" },
        },
      } as JSONRPCMessage)) as unknown as {
        result: { content: { text: string }[]; isError: boolean };
      };
      expect(out.result.isError).toBe(true);
      expect(out.result.content[0]?.text).toContain("missing-id");
    });

    // ============================================================================
    // #526 — submit_approval `action_id` parameter for custom policy-injection
    // buttons (`block_*`). Foreman wires it through to submitFromAgent so the
    // approval service can look up the proposed predicate from the persisted
    // approval row + inject the deny rule.
    // ============================================================================

    it("advertises the action_id parameter in submit_approval's input schema (#526)", async () => {
      const out = (await handleMessage(makeServices("allowed"), "hermes", {
        jsonrpc: "2.0",
        id: 16,
        method: "tools/list",
      } as JSONRPCMessage)) as unknown as {
        result: {
          tools: Array<{
            name: string;
            inputSchema?: { properties?: Record<string, unknown> };
          }>;
        };
      };
      const submit = out.result.tools.find((t) => t.name === "submit_approval");
      expect(submit?.inputSchema?.properties).toHaveProperty("action_id");
    });

    it("forwards action_id verbatim to submitFromAgent (#526)", async () => {
      const services = makeServices("allowed");
      await handleMessage(services, "hermes", {
        jsonrpc: "2.0",
        id: 17,
        method: "tools/call",
        params: {
          name: "submit_approval",
          arguments: {
            approval_id: "appr-abc",
            decision: "deny",
            action_id: "block_secret_path",
          },
        },
      } as JSONRPCMessage);
      expect(services.approval.submitFromAgent).toHaveBeenCalledWith({
        approvalId: "appr-abc",
        decision: "deny",
        remember: false,
        sourceAgent: "hermes",
        actionId: "block_secret_path",
      });
    });

    it("omits action_id from the forwarded call when the field is absent (#526)", async () => {
      // Plain allow/deny path stays bit-identical — actionId is undefined
      // so submitFromAgent's existing signature consumers see no change.
      const services = makeServices("allowed");
      await handleMessage(services, "hermes", {
        jsonrpc: "2.0",
        id: 18,
        method: "tools/call",
        params: {
          name: "submit_approval",
          arguments: { approval_id: "appr-plain", decision: "allow" },
        },
      } as JSONRPCMessage);
      const call = (
        services.approval.submitFromAgent as unknown as {
          mock: { calls: unknown[][] };
        }
      ).mock.calls[0]?.[0] as Record<string, unknown>;
      expect(call.actionId).toBeUndefined();
    });

    // ============================================================================
    // #527 — submit_resolution tool: user taps a "Skip / Let PM decide / I'll
    // decide / Abandon" button on a halt prompt; the agent relays via this MCP
    // tool; Foreman flips the session out of halt + enqueues a write to the
    // participating agents.
    // ============================================================================
    it("advertises submit_resolution in tools/list (#527)", async () => {
      const out = (await handleMessage(makeServices("allowed"), "hermes", {
        jsonrpc: "2.0",
        id: 30,
        method: "tools/list",
      } as JSONRPCMessage)) as unknown as {
        result: { tools: { name: string }[] };
      };
      expect(out.result.tools.map((t) => t.name)).toContain("submit_resolution");
    });

    it("forwards session_id + option_id + source_user to sessionManager.provideResolution (#527)", async () => {
      const services = makeServices("allowed");
      // Stub the session manager so the handler has somewhere to call.
      const provideSpy = vi.fn(() => ({
        id: "opt-skip",
        label: "Skip — decide later",
        payload: { kind: "skip", note: "skip" },
      }));
      (services as unknown as { sessionManager: unknown }).sessionManager = {
        provideResolution: provideSpy,
      };
      const out = (await handleMessage(services, "hermes", {
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: {
          name: "submit_resolution",
          arguments: {
            session_id: "sess-abc",
            option_id: "opt-skip",
            source_user: "tg-user-1",
          },
        },
      } as JSONRPCMessage)) as unknown as {
        result: { content: { text: string }[] };
      };
      expect(provideSpy).toHaveBeenCalledWith("sess-abc", "opt-skip", {
        providedBy: "tg-user-1",
      });
      expect(out.result.content[0]?.text).toContain("Resolution submitted");
      expect(out.result.content[0]?.text).toContain("Skip");
    });

    it("returns an isError reply when the option_id is unknown (#527)", async () => {
      const services = makeServices("allowed");
      (services as unknown as { sessionManager: unknown }).sessionManager = {
        provideResolution: vi.fn(() => null),
      };
      const out = (await handleMessage(services, "hermes", {
        jsonrpc: "2.0",
        id: 32,
        method: "tools/call",
        params: {
          name: "submit_resolution",
          arguments: { session_id: "sess-abc", option_id: "opt-nope" },
        },
      } as JSONRPCMessage)) as unknown as {
        result: { content: { text: string }[]; isError: boolean };
      };
      expect(out.result.isError).toBe(true);
      expect(out.result.content[0]?.text).toContain("Unknown resolution option");
    });

    it("rejects submit_resolution without session_id (#527)", async () => {
      const out = (await handleMessage(makeServices("allowed"), "hermes", {
        jsonrpc: "2.0",
        id: 33,
        method: "tools/call",
        params: {
          name: "submit_resolution",
          arguments: { option_id: "opt-skip" },
        },
      } as JSONRPCMessage)) as unknown as {
        error: { code: number; message: string };
      };
      expect(out.error.code).toBe(-32602);
      expect(out.error.message).toMatch(/session_id/);
    });

    it("rejects submit_resolution without option_id (#527)", async () => {
      const out = (await handleMessage(makeServices("allowed"), "hermes", {
        jsonrpc: "2.0",
        id: 34,
        method: "tools/call",
        params: {
          name: "submit_resolution",
          arguments: { session_id: "sess-abc" },
        },
      } as JSONRPCMessage)) as unknown as {
        error: { code: number; message: string };
      };
      expect(out.error.code).toBe(-32602);
      expect(out.error.message).toMatch(/option_id/);
    });

    it("echoes the policy rule id back when submitFromAgent returns one (#526)", async () => {
      const services = makeServices("allowed", "policy:7", undefined, {
        ok: true,
        // Simulate the custom path returning a rule id; the chat reply
        // should surface it so the user sees what was added.
      } as { ok: boolean; error?: string });
      (services.approval.submitFromAgent as unknown as {
        mockResolvedValueOnce: (v: { ok: boolean; policyRuleId: number }) => void;
      }).mockResolvedValueOnce({ ok: true, policyRuleId: 42 });
      const out = (await handleMessage(services, "hermes", {
        jsonrpc: "2.0",
        id: 19,
        method: "tools/call",
        params: {
          name: "submit_approval",
          arguments: {
            approval_id: "appr-rule",
            decision: "deny",
            action_id: "block_secret_path",
          },
        },
      } as JSONRPCMessage)) as unknown as {
        result: { content: { text: string }[] };
      };
      expect(out.result.content[0]?.text).toContain("policy rule #42");
    });
  });

  // #431 — Agent-routed orchestrator command. User types `/foreman <verb>`
  // in the agent's chat; agent calls submit_command; Foreman dispatches
  // via the command router; agent posts the response back.
  describe("submit_command tool (#431)", () => {
    it("advertises submit_command on tools/list", async () => {
      const out = (await handleMessage(makeServices("allowed"), "hermes", {
        jsonrpc: "2.0",
        id: 20,
        method: "tools/list",
      } as JSONRPCMessage)) as unknown as {
        result: { tools: { name: string }[] };
      };
      const names = out.result.tools.map((t) => t.name);
      expect(names).toContain("submit_command");
    });

    it("forwards command + args + sourceAgent to commandRouter.dispatch", async () => {
      const services = makeServices(
        "allowed",
        "policy:7",
        undefined,
        { ok: true },
        { ok: true, text: "Foreman v0.1.x — 2 agents registered" },
      );
      const out = (await handleMessage(services, "hermes", {
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: {
          name: "submit_command",
          arguments: {
            command: "status",
            args: [],
            source_user: "12345",
          },
        },
      } as JSONRPCMessage)) as unknown as {
        result: { content: { text: string }[]; isError?: boolean };
      };
      expect(services.commandRouter.dispatch).toHaveBeenCalledWith(
        "status",
        [],
        expect.objectContaining({
          sourceAgent: "hermes",
          sourceUser: "12345",
        }),
      );
      expect(out.result.content[0]?.text).toContain("Foreman");
      expect(out.result.isError).toBeFalsy();
    });

    it("preserves nested args (e.g. `/foreman llm status` → args=['status'])", async () => {
      const services = makeServices(
        "allowed",
        "policy:7",
        undefined,
        { ok: true },
        { ok: true, text: "llm response" },
      );
      await handleMessage(services, "openclaw", {
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: {
          name: "submit_command",
          arguments: { command: "llm", args: ["status"] },
        },
      } as JSONRPCMessage);
      expect(services.commandRouter.dispatch).toHaveBeenCalledWith(
        "llm",
        ["status"],
        expect.objectContaining({ sourceAgent: "openclaw" }),
      );
    });

    it("returns isError true when the router reports ok=false", async () => {
      const services = makeServices(
        "allowed",
        "policy:7",
        undefined,
        { ok: true },
        {
          ok: false,
          text: 'Unknown command "supernova".',
          errorCode: "UNKNOWN_COMMAND",
        },
      );
      const out = (await handleMessage(services, "hermes", {
        jsonrpc: "2.0",
        id: 23,
        method: "tools/call",
        params: {
          name: "submit_command",
          arguments: { command: "supernova", args: [] },
        },
      } as JSONRPCMessage)) as unknown as {
        result: { content: { text: string }[]; isError: boolean };
      };
      expect(out.result.isError).toBe(true);
      expect(out.result.content[0]?.text).toContain("supernova");
    });

    it("rejects submit_command without a command arg", async () => {
      const out = (await handleMessage(makeServices("allowed"), "hermes", {
        jsonrpc: "2.0",
        id: 24,
        method: "tools/call",
        params: { name: "submit_command", arguments: {} },
      } as JSONRPCMessage)) as unknown as {
        error: { code: number; message: string };
      };
      expect(out.error.code).toBe(-32602);
      expect(out.error.message).toMatch(/command/);
    });

    it("filters non-string entries out of args (defensive)", async () => {
      const services = makeServices(
        "allowed",
        "policy:7",
        undefined,
        { ok: true },
        { ok: true, text: "ok" },
      );
      await handleMessage(services, "hermes", {
        jsonrpc: "2.0",
        id: 25,
        method: "tools/call",
        params: {
          name: "submit_command",
          arguments: {
            command: "echo",
            args: ["one", 42, "two", null, "three"] as unknown[],
          },
        },
      } as JSONRPCMessage);
      expect(services.commandRouter.dispatch).toHaveBeenCalledWith(
        "echo",
        ["one", "two", "three"],
        expect.any(Object),
      );
    });

    it("writes an audit row per invocation (foreman:command event)", async () => {
      const services = makeServices(
        "allowed",
        "policy:7",
        undefined,
        { ok: true },
        { ok: true, text: "ok" },
      );
      await handleMessage(services, "hermes", {
        jsonrpc: "2.0",
        id: 26,
        method: "tools/call",
        params: {
          name: "submit_command",
          arguments: {
            command: "status",
            args: [],
            source_user: "42",
          },
        },
      } as JSONRPCMessage);
      expect(services.audit.logEvent).toHaveBeenCalledWith(
        "foreman:command",
        expect.objectContaining({
          command: "status",
          args: [],
          sourceAgent: "hermes",
          sourceUser: "42",
          ok: true,
        }),
      );
    });

    it("audit row records failures with the error code", async () => {
      const services = makeServices(
        "allowed",
        "policy:7",
        undefined,
        { ok: true },
        {
          ok: false,
          text: "Unknown command",
          errorCode: "UNKNOWN_COMMAND",
        },
      );
      await handleMessage(services, "hermes", {
        jsonrpc: "2.0",
        id: 27,
        method: "tools/call",
        params: {
          name: "submit_command",
          arguments: { command: "supernova", args: [] },
        },
      } as JSONRPCMessage);
      expect(services.audit.logEvent).toHaveBeenCalledWith(
        "foreman:command",
        expect.objectContaining({
          command: "supernova",
          ok: false,
          errorCode: "UNKNOWN_COMMAND",
        }),
      );
    });
  });
});
