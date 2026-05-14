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
import { checkForUpdate, isNewer } from "../../src/core/update-check.js";

describe("isNewer (semver compare)", () => {
  it.each([
    ["0.1.1", "0.1.0", true],
    ["0.2.0", "0.1.9", true],
    ["1.0.0", "0.99.99", true],
    ["0.1.0", "0.1.0", false],
    ["0.1.0", "0.1.1", false],
    ["0.1.0-pre", "0.1.0", false],
    ["0.1.0", "0.1.0-pre", true],
    ["malformed", "0.1.0", false],
    ["0.1.0", "malformed", false],
  ])("isNewer(%s, %s) === %s", (a, b, expected) => {
    expect(isNewer(a, b)).toBe(expected);
  });
});

describe("checkForUpdate", () => {
  let tmpDir: string;
  let cachePath: string;
  let savedSkip: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "foreman-uc-"));
    cachePath = join(tmpDir, "version-check.json");
    savedSkip = process.env.FOREMAN_NO_UPDATE_CHECK;
    delete process.env.FOREMAN_NO_UPDATE_CHECK;
  });

  afterEach(() => {
    if (savedSkip === undefined) delete process.env.FOREMAN_NO_UPDATE_CHECK;
    else process.env.FOREMAN_NO_UPDATE_CHECK = savedSkip;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function fakeFetch(version: string, status = 200): typeof fetch {
    const fn = (async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ version }),
    })) as unknown as typeof fetch;
    return fn;
  }

  it("returns null when FOREMAN_NO_UPDATE_CHECK=1 is set", async () => {
    process.env.FOREMAN_NO_UPDATE_CHECK = "1";
    const result = await checkForUpdate("0.1.0", {
      cachePath,
      fetchFn: fakeFetch("9.9.9"),
    });
    expect(result).toBeNull();
    expect(existsSync(cachePath)).toBe(false);
  });

  it("hits the network on first run and writes the cache", async () => {
    const result = await checkForUpdate("0.1.0", {
      cachePath,
      fetchFn: fakeFetch("0.1.5"),
    });
    expect(result).not.toBeNull();
    expect(result?.latest).toBe("0.1.5");
    expect(result?.hasUpdate).toBe(true);
    expect(result?.source).toBe("network");
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(cache.latest).toBe("0.1.5");
  });

  it("reads from cache when within TTL", async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({ latest: "0.2.0", observedAt: Date.now() }),
    );
    const result = await checkForUpdate("0.1.0", {
      cachePath,
      fetchFn: (() => {
        throw new Error("network should not be hit");
      }) as unknown as typeof fetch,
    });
    expect(result?.source).toBe("cache");
    expect(result?.latest).toBe("0.2.0");
    expect(result?.hasUpdate).toBe(true);
  });

  it("refreshes when the cache is older than the TTL", async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        latest: "0.0.1",
        observedAt: Date.now() - 25 * 60 * 60 * 1000,
      }),
    );
    const result = await checkForUpdate("0.1.0", {
      cachePath,
      fetchFn: fakeFetch("0.1.7"),
    });
    expect(result?.source).toBe("network");
    expect(result?.latest).toBe("0.1.7");
  });

  it("returns null silently on a network error (no throw)", async () => {
    const fn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await checkForUpdate("0.1.0", { cachePath, fetchFn: fn });
    expect(result).toBeNull();
  });

  it("returns null when the registry returns a non-2xx", async () => {
    const result = await checkForUpdate("0.1.0", {
      cachePath,
      fetchFn: fakeFetch("0.1.0", 503),
    });
    expect(result).toBeNull();
    expect(existsSync(cachePath)).toBe(false);
  });

  it("reports hasUpdate=false when installed === latest", async () => {
    mkdirSync(tmpDir, { recursive: true });
    const result = await checkForUpdate("0.1.0", {
      cachePath,
      fetchFn: fakeFetch("0.1.0"),
    });
    expect(result?.hasUpdate).toBe(false);
  });
});
