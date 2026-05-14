import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  executeMigration,
  LegacyConflictError,
  legacyHasInterestingFiles,
  planMigration,
} from "../../src/utils/migrate-config.js";

describe("planMigration + executeMigration", () => {
  let tmpBase: string;
  let savedHome: string | undefined;
  let savedForemanHome: string | undefined;
  let fakeHome: string;
  let legacyDir: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "foreman-mig-"));
    fakeHome = join(tmpBase, "home");
    legacyDir = join(fakeHome, ".foreman");
    mkdirSync(legacyDir, { recursive: true });
    savedHome = process.env.HOME;
    savedForemanHome = process.env.FOREMAN_HOME;
    process.env.HOME = fakeHome;
    process.env.FOREMAN_HOME = join(tmpBase, "new-layout");
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedForemanHome === undefined) delete process.env.FOREMAN_HOME;
    else process.env.FOREMAN_HOME = savedForemanHome;
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("reports no-legacy when ~/.foreman/ does not exist", () => {
    rmSync(legacyDir, { recursive: true });
    const plan = planMigration({ homeDir: fakeHome });
    expect(plan.status).toBe("no-legacy");
    expect(plan.moves).toHaveLength(0);
  });

  it("reports done when ~/.foreman/ exists but contains nothing migratable", () => {
    const plan = planMigration({ homeDir: fakeHome });
    expect(plan.status).toBe("done");
    expect(plan.moves).toHaveLength(0);
  });

  it("plans every config + state + cache file present in the legacy dir", () => {
    writeFileSync(join(legacyDir, "policy.yaml"), "rules: []\n");
    writeFileSync(join(legacyDir, "identity.key"), Buffer.alloc(32));
    writeFileSync(join(legacyDir, "secrets.key"), Buffer.alloc(32));
    writeFileSync(join(legacyDir, "foreman.db"), "fake-db-content");
    mkdirSync(join(legacyDir, "cache"));
    writeFileSync(join(legacyDir, "cache", "registry.json"), "{}");

    const plan = planMigration({ homeDir: fakeHome });
    expect(plan.status).toBe("ready");
    const buckets = plan.moves.map((m) => m.destDir);
    expect(buckets.filter((b) => b === "config").length).toBe(3);
    expect(buckets.filter((b) => b === "state").length).toBe(1);
    expect(buckets.filter((b) => b === "cache").length).toBe(1);
  });

  it("executes the plan and preserves DB byte-for-byte", () => {
    const dbBytes = Buffer.from("REAL-DB-PRETEND-CONTENT-1234567890");
    writeFileSync(join(legacyDir, "foreman.db"), dbBytes);
    writeFileSync(join(legacyDir, "policy.yaml"), "rules: [foo]\n");

    const plan = planMigration({ homeDir: fakeHome });
    expect(plan.status).toBe("ready");
    const result = executeMigration(plan);
    expect(result.movedCount).toBe(2);
    expect(result.skippedCount).toBe(0);

    const newPolicy = join(plan.configDir, "policy.yaml");
    const newDb = join(plan.stateDir, "foreman.db");
    expect(existsSync(newPolicy)).toBe(true);
    expect(existsSync(newDb)).toBe(true);
    expect(readFileSync(newDb).equals(dbBytes)).toBe(true);
    expect(readFileSync(newPolicy, "utf8")).toBe("rules: [foo]\n");
    expect(existsSync(join(legacyDir, "policy.yaml"))).toBe(false);
    expect(existsSync(join(legacyDir, "foreman.db"))).toBe(false);
  });

  it("refuses to overwrite an existing file in the new layout without --force", () => {
    writeFileSync(join(legacyDir, "policy.yaml"), "rules: [legacy]\n");
    const plan = planMigration({ homeDir: fakeHome });
    mkdirSync(plan.configDir, { recursive: true });
    writeFileSync(join(plan.configDir, "policy.yaml"), "rules: [new]\n");

    const plan2 = planMigration({ homeDir: fakeHome });
    expect(plan2.status).toBe("destination-has-data");
    expect(() => executeMigration(plan2)).toThrow(LegacyConflictError);
    expect(readFileSync(join(legacyDir, "policy.yaml"), "utf8")).toBe(
      "rules: [legacy]\n",
    );
  });

  it("re-running the migration after success is a no-op", () => {
    writeFileSync(join(legacyDir, "policy.yaml"), "rules: []\n");
    executeMigration(planMigration({ homeDir: fakeHome }));
    const replan = planMigration({ homeDir: fakeHome });
    expect(replan.status).toBe("done");
    const result = executeMigration(replan);
    expect(result.movedCount).toBe(0);
  });

  it("legacyHasInterestingFiles returns true only when there is something to migrate", () => {
    expect(legacyHasInterestingFiles(fakeHome)).toBe(false);
    writeFileSync(join(legacyDir, "policy.yaml"), "rules: []\n");
    expect(legacyHasInterestingFiles(fakeHome)).toBe(true);
    rmSync(join(legacyDir, "policy.yaml"));
    expect(legacyHasInterestingFiles(fakeHome)).toBe(false);
  });
});
