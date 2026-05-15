import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkAgentsRegistered,
  checkChafa,
  checkDatabase,
  checkExpectedFiles,
  checkForemanHome,
  checkFts5,
  checkIdentityKey,
  checkMcpGateway,
  checkNodeVersion,
  checkPolicyYaml,
  computeExitCode,
  computeSummary,
  runDoctor,
  type CheckResult,
} from "../../src/core/doctor.js";
import { closeDb } from "../../src/db/client.js";
import { runInit } from "../../src/cli/init.js";

describe("computeSummary", () => {
  it("returns all zeros for an empty list", () => {
    expect(computeSummary([])).toEqual({ ok: 0, warn: 0, fail: 0 });
  });

  it("counts every status independently", () => {
    expect(
      computeSummary([
        { name: "a", status: "ok", message: "" },
        { name: "b", status: "ok", message: "" },
        { name: "c", status: "warn", message: "" },
        { name: "d", status: "fail", message: "" },
        { name: "e", status: "fail", message: "" },
      ]),
    ).toEqual({ ok: 2, warn: 1, fail: 2 });
  });

  it("runDoctor includes summary on the returned report", () => {
    const report = runDoctor();
    expect(report.summary.ok + report.summary.warn + report.summary.fail).toBe(
      report.checks.length,
    );
  });
});

describe("computeExitCode", () => {
  it("returns 0 when all checks pass", () => {
    expect(
      computeExitCode([
        { name: "a", status: "ok", message: "" },
        { name: "b", status: "ok", message: "" },
      ]),
    ).toBe(0);
  });

  it("returns 1 on any warning when nothing fails", () => {
    expect(
      computeExitCode([
        { name: "a", status: "ok", message: "" },
        { name: "b", status: "warn", message: "" },
      ]),
    ).toBe(1);
  });

  it("returns 2 when any check fails (warnings ignored)", () => {
    expect(
      computeExitCode([
        { name: "a", status: "warn", message: "" },
        { name: "b", status: "fail", message: "" },
        { name: "c", status: "ok", message: "" },
      ]),
    ).toBe(2);
  });
});

describe("checkNodeVersion", () => {
  it("passes on the current process (suite requires Node 20+)", () => {
    const result = checkNodeVersion();
    expect(result.status).toBe("ok");
    expect(result.message).toContain(process.versions.node);
  });
});

// Most file-system checks need an isolated FOREMAN_HOME. The shared helper
// below creates a temp dir, points FOREMAN_HOME at it, and gives each test a
// clean slate.
function withTmpHome(): {
  setup: () => string;
  teardown: () => void;
} {
  let tmp: string | null = null;
  let previous: string | undefined;
  return {
    setup(): string {
      tmp = mkdtempSync(join(tmpdir(), "foreman-doctor-"));
      previous = process.env.FOREMAN_HOME;
      process.env.FOREMAN_HOME = tmp;
      return tmp;
    },
    teardown(): void {
      closeDb();
      if (previous === undefined) delete process.env.FOREMAN_HOME;
      else process.env.FOREMAN_HOME = previous;
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      tmp = null;
    },
  };
}

describe("checkForemanHome", () => {
  const home = withTmpHome();

  beforeEach(() => {
    home.setup();
  });
  afterEach(() => {
    home.teardown();
  });

  it("fails when FOREMAN_HOME points at a missing directory", () => {
    // withTmpHome creates the dir; explicitly point at a path that doesn't exist.
    process.env.FOREMAN_HOME = join(tmpdir(), "foreman-missing-xyz-001");
    const result = checkForemanHome();
    expect(result.status).toBe("fail");
    expect(result.remediation).toContain("foreman init");
  });

  it("passes when the directory exists and is writable", () => {
    runInit();
    expect(checkForemanHome().status).toBe("ok");
  });
});

describe("checkExpectedFiles", () => {
  const home = withTmpHome();

  beforeEach(() => {
    home.setup();
  });
  afterEach(() => {
    home.teardown();
  });

  it("flags every missing file in one error", () => {
    runInit();
    const dbPath = join(process.env.FOREMAN_HOME!, "foreman.db");
    rmSync(dbPath);
    closeDb();
    const result = checkExpectedFiles();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("foreman.db");
    expect(result.remediation).toContain("foreman init");
  });

  it("passes after a fresh init", () => {
    runInit();
    expect(checkExpectedFiles().status).toBe("ok");
  });
});

describe("checkIdentityKey", () => {
  const home = withTmpHome();

  beforeEach(() => {
    home.setup();
  });
  afterEach(() => {
    home.teardown();
  });

  it("fails when identity.key is missing", () => {
    const result = checkIdentityKey();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("not found");
  });

  it("fails when identity.key is not 32 bytes (corrupt)", () => {
    runInit();
    const idPath = join(process.env.FOREMAN_HOME!, "identity.key");
    writeFileSync(idPath, Buffer.from([1, 2, 3, 4]));
    const result = checkIdentityKey();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("4 bytes");
  });

  it("passes on a freshly created identity", () => {
    runInit();
    const result = checkIdentityKey();
    expect(result.status).toBe("ok");
    expect(result.message).toMatch(/^ed25519:[0-9a-f]{8}/);
  });
});

describe("checkDatabase", () => {
  const home = withTmpHome();

  beforeEach(() => {
    home.setup();
  });
  afterEach(() => {
    home.teardown();
  });

  it("fails when foreman.db is missing", () => {
    const result = checkDatabase();
    expect(result.status).toBe("fail");
    expect(result.remediation).toContain("foreman init");
  });

  it("passes after init", () => {
    runInit();
    expect(checkDatabase().status).toBe("ok");
  });
});

describe("checkFts5", () => {
  it("passes because better-sqlite3 ships with FTS5 on supported platforms", () => {
    const result = checkFts5();
    expect(result.status).toBe("ok");
    expect(result.message).toContain("FTS5");
  });
});

describe("checkPolicyYaml", () => {
  const home = withTmpHome();

  beforeEach(() => {
    home.setup();
  });
  afterEach(() => {
    home.teardown();
  });

  it("fails when policy.yaml is missing", () => {
    expect(checkPolicyYaml().status).toBe("fail");
  });

  it("fails when policy.yaml is malformed", () => {
    runInit();
    writeFileSync(
      join(process.env.FOREMAN_HOME!, "policy.yaml"),
      "agents:\n  hermes:\n    can_call: [broken: yaml",
    );
    expect(checkPolicyYaml().status).toBe("fail");
  });

  it("fails when policy.yaml top-level is an array instead of an object", () => {
    runInit();
    writeFileSync(join(process.env.FOREMAN_HOME!, "policy.yaml"), "- a\n- b\n");
    expect(checkPolicyYaml().status).toBe("fail");
  });

  it("passes on the template policy.yaml after init", () => {
    runInit();
    expect(checkPolicyYaml().status).toBe("ok");
  });
});

describe("checkAgentsRegistered", () => {
  const home = withTmpHome();

  beforeEach(() => {
    home.setup();
  });
  afterEach(() => {
    home.teardown();
  });

  it("warns (not fails) on a fresh init with zero agents", () => {
    runInit();
    const result = checkAgentsRegistered();
    expect(result.status).toBe("warn");
    expect(result.remediation).toContain("foreman agent add");
  });
});

describe("checkMcpGateway", () => {
  it("instantiates and disposes cleanly", () => {
    expect(checkMcpGateway().status).toBe("ok");
  });
});

describe("checkChafa", () => {
  it("warns when chafa is not on PATH", () => {
    const result = checkChafa({ PATH: "/nowhere" });
    expect(result.status).toBe("warn");
    expect(result.remediation).toContain("chafa");
  });

  it("passes when a chafa binary is found on PATH", () => {
    const tmp = mkdtempSync(join(tmpdir(), "foreman-chafa-"));
    try {
      const fakeChafa = join(tmp, "chafa");
      writeFileSync(fakeChafa, "#!/bin/sh\necho ok\n");
      chmodSync(fakeChafa, 0o755);
      expect(checkChafa({ PATH: tmp }).status).toBe("ok");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("runDoctor (integration)", () => {
  const home = withTmpHome();

  beforeEach(() => {
    home.setup();
  });
  afterEach(() => {
    home.teardown();
  });

  it("on a fresh init returns ok except the no-agents warning", () => {
    runInit();
    const report = runDoctor();
    expect(report.exitCode).toBe(1);
    const byName = Object.fromEntries(
      report.checks.map((c: CheckResult) => [c.name, c.status]),
    );
    expect(byName.foreman_home).toBe("ok");
    expect(byName.identity_key).toBe("ok");
    expect(byName.database).toBe("ok");
    expect(byName.fts5).toBe("ok");
    expect(byName.policy_yaml).toBe("ok");
    expect(byName.agents_registered).toBe("warn");
    expect(byName.mcp_gateway).toBe("ok");
  });

  it("after deleting foreman.db reports a failing database check pointing at init", () => {
    runInit();
    rmSync(join(process.env.FOREMAN_HOME!, "foreman.db"));
    closeDb();
    const report = runDoctor();
    expect(report.exitCode).toBe(2);
    const db = report.checks.find((c) => c.name === "database");
    expect(db?.status).toBe("fail");
    expect(db?.remediation).toContain("foreman init");
  });

  it("--json output (the report object) is JSON.stringify-roundtrip safe", () => {
    // Make sure a clean snapshot survives a JSON round-trip — this mirrors what
    // --json on the CLI emits.
    runInit();
    const report = runDoctor();
    const roundTripped = JSON.parse(JSON.stringify(report));
    expect(roundTripped.exitCode).toBe(report.exitCode);
    expect(roundTripped.checks.length).toBe(report.checks.length);
  });

});
