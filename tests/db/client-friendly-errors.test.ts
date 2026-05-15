import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/client.js";

describe("getDb — friendly errors on a non-database file", () => {
  let tmpHome: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "foreman-db-err-"));
    savedHome = process.env.FOREMAN_HOME;
    process.env.FOREMAN_HOME = tmpHome;
  });

  afterEach(() => {
    closeDb();
    if (savedHome === undefined) delete process.env.FOREMAN_HOME;
    else process.env.FOREMAN_HOME = savedHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("wraps SQLITE_NOTADB in a foremanFriendly Error with remediation text", () => {
    writeFileSync(join(tmpHome, "foreman.db"), "garbage that is not sqlite");
    let caught: unknown;
    try {
      getDb();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { foremanFriendly?: boolean };
    expect(err.foremanFriendly).toBe(true);
    expect(err.message).toMatch(/not a valid Foreman database/);
    expect(err.message).toMatch(/foreman init/);
    expect(err.message).not.toMatch(/SqliteError/);
  });
});
