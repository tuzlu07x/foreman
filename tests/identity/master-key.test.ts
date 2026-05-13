import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateSecretsMasterKey } from "../../src/identity/master-key.js";

describe("loadOrCreateSecretsMasterKey", () => {
  let tmpHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "foreman-mk-"));
    previousHome = process.env.FOREMAN_HOME;
    process.env.FOREMAN_HOME = tmpHome;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.FOREMAN_HOME;
    else process.env.FOREMAN_HOME = previousHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("creates a 32-byte master key file when none exists", () => {
    const key = loadOrCreateSecretsMasterKey();
    expect(key.length).toBe(32);
    const path = join(tmpHome, "secrets.key");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).length).toBe(32);
  });

  it("returns the same bytes on repeated calls (persisted to disk)", () => {
    const first = loadOrCreateSecretsMasterKey();
    const second = loadOrCreateSecretsMasterKey();
    expect(first.equals(second)).toBe(true);
  });

  it("writes the file with 0600 perms on POSIX systems", () => {
    if (process.platform === "win32") return;
    loadOrCreateSecretsMasterKey();
    const mode = statSync(join(tmpHome, "secrets.key")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
