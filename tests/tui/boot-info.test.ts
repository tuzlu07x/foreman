import { describe, expect, it } from "vitest";
import {
  buildBootLines,
  fingerprint,
  gatewayDetail,
  type BootInfo,
} from "../../src/tui/boot-info.js";

function makeInfo(overrides: Partial<BootInfo> = {}): BootInfo {
  return {
    publicKey: Buffer.from([0x7a, 0x3f, 0xc0, 0xde, 1, 2, 3, 4]),
    policyRules: 12,
    dbPath: "/home/fatih/.foreman/foreman.db",
    gateway: { stdio: true },
    version: "0.1.0-pre",
    ...overrides,
  };
}

describe("fingerprint", () => {
  it("returns the first 4 bytes as hex", () => {
    expect(fingerprint(Buffer.from([0x7a, 0x3f, 0xc0, 0xde, 0xff]))).toBe(
      "7a3fc0de",
    );
  });
});

describe("gatewayDetail", () => {
  it("returns (stdio) when only stdio is up", () => {
    expect(gatewayDetail({ stdio: true })).toBe("(stdio)");
  });
  it("returns (stdio + ws:N) when both are up", () => {
    expect(gatewayDetail({ stdio: true, wsPort: 7700 })).toBe(
      "(stdio + ws:7700)",
    );
  });
  it("returns (ws:N) when only ws is up", () => {
    expect(gatewayDetail({ stdio: false, wsPort: 7700 })).toBe("(ws:7700)");
  });
});

describe("buildBootLines", () => {
  it("emits four lines in the right order with fingerprint + rule count + path + gateway", () => {
    const lines = buildBootLines(makeInfo());
    expect(lines.map((l) => l.label)).toEqual([
      "Identity loaded",
      "Policy loaded",
      "Database ready",
      "MCP gateway up",
    ]);
    expect(lines[0]?.detail).toBe("(ed25519:7a3fc0de…)");
    expect(lines[1]?.detail).toBe("(12 rules)");
    expect(lines[2]?.detail).toContain("foreman.db");
    expect(lines[3]?.detail).toBe("(stdio)");
  });

  it('singular "1 rule" when there is exactly one', () => {
    const lines = buildBootLines(makeInfo({ policyRules: 1 }));
    expect(lines[1]?.detail).toBe("(1 rule)");
  });

  it("zero rules reads naturally", () => {
    const lines = buildBootLines(makeInfo({ policyRules: 0 }));
    expect(lines[1]?.detail).toBe("(0 rules)");
  });
});
