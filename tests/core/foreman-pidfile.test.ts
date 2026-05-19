import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteForemanPidfile,
  getForemanPidfilePath,
  readForemanPid,
  writeForemanPidfile,
} from "../../src/core/foreman-pidfile.js";

describe("foreman pidfile (#431 stop dependency)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "foreman-pid-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes the current process PID to <configDir>/foreman.pid", () => {
    writeForemanPidfile(tmp);
    const path = getForemanPidfilePath(tmp);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(String(process.pid));
  });

  it("reads the PID back when the process is alive", () => {
    writeForemanPidfile(tmp);
    const pid = readForemanPid(tmp);
    expect(pid).toBe(process.pid);
  });

  it("returns null when the pidfile doesn't exist", () => {
    expect(readForemanPid(tmp)).toBeNull();
  });

  it("returns null when the pidfile is malformed", () => {
    writeFileSync(getForemanPidfilePath(tmp), "not a number", "utf-8");
    expect(readForemanPid(tmp)).toBeNull();
  });

  it("returns null when the pidfile points at a non-existent PID", () => {
    // 2^31 - 1 is way out of normal PID ranges on every platform.
    writeFileSync(getForemanPidfilePath(tmp), "2147483647", "utf-8");
    expect(readForemanPid(tmp)).toBeNull();
  });

  it("returns null for non-positive PIDs (0, negative)", () => {
    writeFileSync(getForemanPidfilePath(tmp), "0", "utf-8");
    expect(readForemanPid(tmp)).toBeNull();
    writeFileSync(getForemanPidfilePath(tmp), "-1", "utf-8");
    expect(readForemanPid(tmp)).toBeNull();
  });

  it("delete removes the file when present, no-op when absent", () => {
    writeForemanPidfile(tmp);
    expect(existsSync(getForemanPidfilePath(tmp))).toBe(true);
    deleteForemanPidfile(tmp);
    expect(existsSync(getForemanPidfilePath(tmp))).toBe(false);
    // Second call should not throw.
    deleteForemanPidfile(tmp);
  });
});
