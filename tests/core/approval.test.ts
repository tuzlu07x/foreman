import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DenyAllApprovalService,
  ReadlineApprovalService,
  type ApprovalDecision,
  type ApprovalRequest,
} from "../../src/core/approval.js";
import { EventBus, type ForemanEventMap } from "../../src/core/event-bus.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

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
    riskReasons: ["secret_file_pattern", "first_agent_to_agent"],
    riskFactors: [],
    riskBucket: "high",
    llmVerification: null,
    ...overrides,
  };
}

interface Harness {
  input: PassThrough;
  output: PassThrough;
  written: string[];
  bus: EventBus<ForemanEventMap>;
  service: ReadlineApprovalService;
  resolved: { event: ForemanEventMap["approval:resolved"]; calls: number };
}

function makeHarness(timeoutMs = 1000): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: string[] = [];
  output.on("data", (chunk: Buffer) => written.push(chunk.toString("utf-8")));
  const bus = new EventBus<ForemanEventMap>();
  const resolved = {
    event: null as unknown as ForemanEventMap["approval:resolved"],
    calls: 0,
  };
  bus.on("approval:resolved", (e) => {
    resolved.event = e;
    resolved.calls += 1;
  });
  const service = new ReadlineApprovalService({
    input,
    output,
    timeoutMs,
    bus,
  });
  return { input, output, written, bus, service, resolved };
}

describe("DenyAllApprovalService", () => {
  it("always returns denied", async () => {
    const service = new DenyAllApprovalService();
    const decision: ApprovalDecision = await service.request({
      requestId: "r",
      sourceAgent: "x",
      args: {},
      riskScore: 0,
      riskReasons: [],
      riskFactors: [],
      riskBucket: "low",
      llmVerification: null,
    });
    expect(decision.decision).toBe("denied");
  });
});

describe("ReadlineApprovalService", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness(500);
  });

  afterEach(() => {
    h.input.destroy();
    h.output.destroy();
  });

  it("renders the prompt with mascot, agent flow, tool call, reasons", async () => {
    const pending = h.service.request(makeRequest());
    h.input.write("d\n");
    await pending;
    const text = stripAnsi(h.written.join(""));
    expect(text).toContain("Approval Required");
    expect(text).toContain("risk: 80");
    expect(text).toContain("(o.o)");
    expect(text).toContain("hermes → claude-code");
    expect(text).toContain('read_file({"path":".env"})');
    expect(text).toContain("◆ secret_file_pattern");
    expect(text).toContain("◆ first_agent_to_agent");
    expect(text).toContain("[a]llow once");
  });

  it("a → allowed, no remember", async () => {
    const pending = h.service.request(makeRequest());
    h.input.write("a\n");
    const decision = await pending;
    expect(decision).toEqual({ decision: "allowed" });
    expect(h.resolved.calls).toBe(1);
    expect(h.resolved.event).toMatchObject({
      requestId: "req-1",
      decision: "allowed",
      resolvedBy: "user",
    });
  });

  it("d → denied, no remember", async () => {
    const pending = h.service.request(makeRequest());
    h.input.write("d\n");
    const decision = await pending;
    expect(decision).toEqual({ decision: "denied" });
    expect(h.resolved.event.resolvedBy).toBe("user");
  });

  it("r then a → allowed + remember=allow, second prompt rendered", async () => {
    const pending = h.service.request(makeRequest());
    h.input.write("r\na\n");
    const decision = await pending;
    expect(decision).toEqual({ decision: "allowed", remember: "allow" });
    const text = stripAnsi(h.written.join(""));
    expect(text).toContain("Remember as");
  });

  it("r then d → denied + remember=deny", async () => {
    const pending = h.service.request(makeRequest());
    h.input.write("r\nd\n");
    const decision = await pending;
    expect(decision).toEqual({ decision: "denied", remember: "deny" });
  });

  it("unknown input falls through to deny", async () => {
    const pending = h.service.request(makeRequest());
    h.input.write("xyz\n");
    const decision = await pending;
    expect(decision.decision).toBe("denied");
  });

  it("timeout resolves to denied with resolvedBy=timeout", async () => {
    const pending = h.service.request(makeRequest());
    const decision = await pending;
    expect(decision.decision).toBe("denied");
    expect(h.resolved.event.resolvedBy).toBe("timeout");
  });

  it("honours FOREMAN_APPROVAL_TIMEOUT env (seconds)", async () => {
    const saved = process.env.FOREMAN_APPROVAL_TIMEOUT;
    process.env.FOREMAN_APPROVAL_TIMEOUT = "0";
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const bus = new EventBus<ForemanEventMap>();
      const service = new ReadlineApprovalService({ input, output, bus });
      const decision = await service.request(makeRequest());
      expect(decision.decision).toBe("denied");
    } finally {
      if (saved === undefined) delete process.env.FOREMAN_APPROVAL_TIMEOUT;
      else process.env.FOREMAN_APPROVAL_TIMEOUT = saved;
    }
  });

  it("does not emit approval:resolved more than once", async () => {
    const pending = h.service.request(makeRequest());
    h.input.write("a\n");
    await pending;
    expect(h.resolved.calls).toBe(1);
  });
});
