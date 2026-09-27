import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../../src/cli/init.js";
import { checkAgentNodeEngines } from "../../src/core/doctor.js";
import { bus } from "../../src/core/event-bus.js";
import { RegistryService } from "../../src/core/registry.js";
import { closeDb, getDb } from "../../src/db/client.js";

// #646 — `foreman doctor` warns (never fails) when an agent whose registry
// entry declares `engines.node` is registered or on PATH and the node on
// PATH is outside that range. OpenClaw: >=24.16.0 <25 || >=26.1.0.

const OLD_NODE = () => ({ version: "22.12.0", source: "PATH" as const });
const GOOD_NODE = () => ({ version: "24.16.0", source: "PATH" as const });

describe("checkAgentNodeEngines", () => {
  let tmp: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "foreman-doctor-engines-"));
    previousHome = process.env.FOREMAN_HOME;
    process.env.FOREMAN_HOME = tmp;
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.FOREMAN_HOME;
    else process.env.FOREMAN_HOME = previousHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("warns when OpenClaw is registered and Node is below its range", () => {
    const rows = checkAgentNodeEngines({
      env: { PATH: "/nowhere" },
      registeredIds: ["openclaw"],
      resolveNode: OLD_NODE,
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.name).toBe("node_engines:openclaw");
    expect(row.status).toBe("warn");
    expect(row.message).toContain(">=24.16.0 <25 || >=26.1.0");
    expect(row.message).toContain("v22.12.0");
    expect(row.remediation).toContain(
      "curl -fsSL https://openclaw.ai/install.sh | bash",
    );
  });

  it("reports ok when Node is in range", () => {
    const rows = checkAgentNodeEngines({
      env: { PATH: "/nowhere" },
      registeredIds: ["openclaw"],
      resolveNode: GOOD_NODE,
    });
    expect(rows.map((r) => r.status)).toEqual(["ok"]);
  });

  it("stays silent when OpenClaw is neither registered nor installed", () => {
    let probed = false;
    const rows = checkAgentNodeEngines({
      env: { PATH: "/nowhere" },
      registeredIds: ["hermes"],
      resolveNode: () => {
        probed = true;
        return OLD_NODE();
      },
    });
    expect(rows).toEqual([]);
    expect(probed).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "warns when the openclaw binary is on PATH but not registered",
    () => {
      const dir = mkdtempSync(join(tmp, "path-"));
      const fake = join(dir, "openclaw");
      writeFileSync(fake, "#!/bin/sh\necho ok\n");
      chmodSync(fake, 0o755);
      const rows = checkAgentNodeEngines({
        env: { PATH: dir },
        registeredIds: [],
        resolveNode: OLD_NODE,
      });
      expect(rows.map((r) => [r.name, r.status])).toEqual([
        ["node_engines:openclaw", "warn"],
      ]);
    },
  );

  it("finds a registered OpenClaw in the database by its registry id", () => {
    runInit();
    const registry = new RegistryService(getDb(), bus);
    registry.register({
      id: "claw",
      displayName: "OpenClaw",
      transport: "stdio",
      metadata: { registryId: "openclaw" },
    });
    const rows = checkAgentNodeEngines({
      env: { PATH: "/nowhere" },
      resolveNode: OLD_NODE,
    });
    expect(rows.map((r) => [r.name, r.status])).toEqual([
      ["node_engines:openclaw", "warn"],
    ]);
  });
});
