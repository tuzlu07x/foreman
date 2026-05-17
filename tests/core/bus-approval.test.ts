import { describe, expect, it, vi } from "vitest";
import {
  BusApprovalService,
  type ApprovalRequest,
} from "../../src/core/approval.js";
import { EventBus, type ForemanEventMap } from "../../src/core/event-bus.js";

function makeRequest(
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return {
    requestId: "req-1",
    sourceAgent: "hermes",
    targetAgent: "claude-code",
    targetTool: "read_file",
    args: { path: ".env" },
    riskScore: 80,
    riskReasons: ["secret_file_pattern"],
    riskFactors: [],
    riskBucket: "high",
    llmVerification: null,
    securityReport: null,
    ...overrides,
  };
}

describe("BusApprovalService", () => {
  it("resolves when approval:resolved arrives with matching requestId", async () => {
    const bus = new EventBus<ForemanEventMap>();
    const service = new BusApprovalService({ bus, timeoutMs: 1000 });
    const pending = service.request(makeRequest());
    bus.emit("approval:resolved", {
      requestId: "req-1",
      decision: "allowed",
      resolvedBy: "user",
    });
    await expect(pending).resolves.toEqual({ decision: "allowed" });
  });

  it("propagates remember flag from the resolved event", async () => {
    const bus = new EventBus<ForemanEventMap>();
    const service = new BusApprovalService({ bus, timeoutMs: 1000 });
    const pending = service.request(makeRequest());
    bus.emit("approval:resolved", {
      requestId: "req-1",
      decision: "denied",
      remember: "deny",
      resolvedBy: "user",
    });
    await expect(pending).resolves.toEqual({
      decision: "denied",
      remember: "deny",
    });
  });

  it("ignores resolved events for a different requestId", async () => {
    const bus = new EventBus<ForemanEventMap>();
    const service = new BusApprovalService({ bus, timeoutMs: 50 });
    const pending = service.request(makeRequest({ requestId: "mine" }));
    bus.emit("approval:resolved", {
      requestId: "someone-else",
      decision: "allowed",
      resolvedBy: "user",
    });
    const result = await pending;
    expect(result.decision).toBe("denied");
  });

  it("times out to denied + emits approval:resolved with resolvedBy=timeout", async () => {
    const bus = new EventBus<ForemanEventMap>();
    const resolved = vi.fn();
    bus.on("approval:resolved", resolved);
    const service = new BusApprovalService({ bus, timeoutMs: 50 });
    const result = await service.request(makeRequest());
    expect(result.decision).toBe("denied");
    expect(resolved).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-1",
        decision: "denied",
        resolvedBy: "timeout",
      }),
    );
  });

  it("does not double-resolve when both timeout and user fire", async () => {
    const bus = new EventBus<ForemanEventMap>();
    const service = new BusApprovalService({ bus, timeoutMs: 50 });
    const pending = service.request(makeRequest());
    await new Promise((r) => setTimeout(r, 80));
    bus.emit("approval:resolved", {
      requestId: "req-1",
      decision: "allowed",
      resolvedBy: "user",
    });
    await expect(pending).resolves.toEqual({ decision: "denied" });
  });
});
