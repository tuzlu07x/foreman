import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  checkNodeEngine,
  describeNodeEngineMismatch,
  isValidNodeRange,
  resolveInstallerNodeVersion,
  satisfiesNodeRange,
} from "../../src/core/node-engines.js";
import {
  findAgent,
  loadBundledRegistry,
  parseRegistryText,
  RegistryValidationError,
} from "../../src/core/registry-catalog.js";

// #646 — OpenClaw's npm package needs a newer Node than Foreman does.
const OPENCLAW_RANGE = ">=24.16.0 <25 || >=26.1.0";

describe("satisfiesNodeRange", () => {
  it.each([
    ["22.12.0", false],
    ["24.15.9", false],
    ["24.16.0", true],
    ["v24.16.0", true],
    ["24.99.1", true],
    ["25.0.0", false],
    ["25.9.0", false],
    ["26.0.9", false],
    ["26.1.0", true],
    ["27.0.0", true],
  ])("%s → %s against OpenClaw's range", (version, expected) => {
    expect(satisfiesNodeRange(version, OPENCLAW_RANGE)).toBe(expected);
  });

  it("zero-fills partial versions after >= and <", () => {
    expect(satisfiesNodeRange("22.12.0", ">=22.12")).toBe(true);
    expect(satisfiesNodeRange("22.11.9", ">=22.12")).toBe(false);
    expect(satisfiesNodeRange("24.99.99", "<25")).toBe(true);
  });

  it("handles >, <=, and = comparators", () => {
    expect(satisfiesNodeRange("24.16.1", ">24.16.0")).toBe(true);
    expect(satisfiesNodeRange("24.16.0", ">24.16.0")).toBe(false);
    expect(satisfiesNodeRange("24.16.0", "<=24.16.0")).toBe(true);
    expect(satisfiesNodeRange("24.16.0", "=24.16.0")).toBe(true);
    expect(satisfiesNodeRange("24.16.0", "24.16.0")).toBe(true);
  });

  it("ignores a pre-release suffix on the version", () => {
    expect(satisfiesNodeRange("26.1.0-nightly20260901", OPENCLAW_RANGE)).toBe(
      true,
    );
  });

  it("returns false for an unparseable version or range", () => {
    expect(satisfiesNodeRange("not-a-version", OPENCLAW_RANGE)).toBe(false);
    expect(satisfiesNodeRange("24.16.0", "^24.16.0")).toBe(false);
  });
});

describe("isValidNodeRange", () => {
  it.each([OPENCLAW_RANGE, ">=22.12", ">=1.2.3 <2", "<25", "=24.16.0"])(
    "accepts %s",
    (range) => {
      expect(isValidNodeRange(range)).toBe(true);
    },
  );

  it.each(["", "   ", "^24", "~24.1", "<=25", "=24", ">=24.16.0 ||", "latest", "24.x"])(
    "rejects %j",
    (range) => {
      expect(isValidNodeRange(range)).toBe(false);
    },
  );
});

describe("checkNodeEngine", () => {
  const openclaw = findAgent(loadBundledRegistry(), "openclaw");

  it("the bundled OpenClaw entry declares its Node range", () => {
    expect(openclaw.engines?.node).toBe(OPENCLAW_RANGE);
  });

  it("returns null without probing Node when the agent declares no range", () => {
    const resolveNode = vi.fn(() => ({ version: "22.12.0", source: "PATH" as const }));
    const hermes = findAgent(loadBundledRegistry(), "hermes");
    expect(checkNodeEngine(hermes, resolveNode)).toBeNull();
    expect(resolveNode).not.toHaveBeenCalled();
  });

  it("returns null when the installer Node is in range", () => {
    expect(
      checkNodeEngine(openclaw, () => ({ version: "24.16.0", source: "PATH" })),
    ).toBeNull();
  });

  it("reports the requirement and the upstream installer as text", () => {
    const mismatch = checkNodeEngine(
      openclaw,
      () => ({ version: "22.12.0", source: "PATH" }),
      "linux",
    );
    expect(mismatch).toEqual({
      agentName: "OpenClaw",
      required: OPENCLAW_RANGE,
      current: { version: "22.12.0", source: "PATH" },
      upstreamCommand: "curl -fsSL https://openclaw.ai/install.sh | bash",
    });
    const lines = describeNodeEngineMismatch(mismatch!);
    expect(lines[0]).toContain(`OpenClaw needs Node ${OPENCLAW_RANGE}`);
    expect(lines[0]).toContain("v22.12.0");
    expect(lines.join("\n")).toContain(
      "curl -fsSL https://openclaw.ai/install.sh | bash",
    );
    expect(lines.join("\n")).not.toContain("npm install -g");
  });

  it("omits the upstream command when there is none for the platform", () => {
    const mismatch = checkNodeEngine(
      openclaw,
      () => ({ version: "22.12.0", source: "PATH" }),
      "win32",
    );
    expect(mismatch?.upstreamCommand).toBeNull();
    expect(describeNodeEngineMismatch(mismatch!)).toHaveLength(2);
  });
});

describe("resolveInstallerNodeVersion", () => {
  it.skipIf(process.platform === "win32")(
    "reads the node on PATH, not the Node running Foreman",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "foreman-node-engines-"));
      try {
        const fake = join(dir, "node");
        writeFileSync(fake, "#!/bin/sh\necho v24.16.0\n");
        chmodSync(fake, 0o755);
        expect(resolveInstallerNodeVersion({ PATH: dir })).toEqual({
          version: "24.16.0",
          source: "PATH",
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("falls back to Foreman's own Node when no node is on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "foreman-node-engines-empty-"));
    try {
      expect(resolveInstallerNodeVersion({ PATH: dir })).toEqual({
        version: process.versions.node,
        source: "foreman",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("registry schema: engines.node", () => {
  function docWithRange(range: string): string {
    const doc = loadBundledRegistry();
    const agents = doc.agents.map((a) =>
      a.id === "openclaw" ? { ...a, engines: { node: range } } : a,
    );
    return JSON.stringify({ ...doc, agents });
  }

  it("accepts a supported range", () => {
    const doc = parseRegistryText(docWithRange(">=26.1.0"), "test.json");
    expect(findAgent(doc, "openclaw").engines?.node).toBe(">=26.1.0");
  });

  it("rejects a range the checker can't read", () => {
    let issues: { path: string; message: string }[] = [];
    try {
      parseRegistryText(docWithRange("^24.16.0"), "test.json");
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryValidationError);
      issues = (err as RegistryValidationError).issues;
    }
    expect(issues.some((i) => i.path.includes("engines.node"))).toBe(true);
  });
});
