import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cliPath = resolve(__dirname, "..", "..", "dist", "cli", "index.js");

describe("foreman setup — non-TTY stdin (#211)", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "foreman-setup-tty-"));
    spawnSync("node", [cliPath, "init"], {
      env: { ...process.env, FOREMAN_HOME: tmpHome },
    });
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("exits 1 with a friendly message when stdin is not a TTY", () => {
    const result = spawnSync("node", [cliPath, "setup"], {
      env: { ...process.env, FOREMAN_HOME: tmpHome },
      stdio: ["pipe", "pipe", "pipe"],
      input: "",
    });
    expect(result.status).toBe(1);
    const stderr = result.stderr.toString();
    expect(stderr).toMatch(/interactive terminal/i);
    expect(stderr).toMatch(/foreman secrets add/);
    expect(stderr).toMatch(/foreman agent add/);
    expect(stderr).not.toMatch(/Raw mode is not supported/);
    expect(stderr).not.toMatch(/SqliteError/);
  });

  it("applies the same guard to --reset and --resume", () => {
    for (const flag of ["--reset", "--resume"]) {
      const result = spawnSync("node", [cliPath, "setup", flag], {
        env: { ...process.env, FOREMAN_HOME: tmpHome },
        stdio: ["pipe", "pipe", "pipe"],
        input: "",
      });
      expect(result.status, `${flag} should exit 1`).toBe(1);
      expect(result.stderr.toString()).toMatch(/interactive terminal/i);
    }
  });
});
