import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkAgentUpdates,
  getInstalledNpmVersion,
  isOvershoot,
  parseSupportedRangeUpperBound,
} from "../../src/core/agent-update-check.js";
import type { RegistryDoc } from "../../src/core/registry-catalog.js";

function makeRegistry(
  overrides: Partial<{
    npm: string | null;
    supported: string;
  }> = {},
): RegistryDoc {
  return {
    version: 1,
    agents: [
      {
        id: "hermes",
        name: "Hermes",
        tagline: "Personal assistant",
        homepage: "https://example.com/",
        install: {
          npm: overrides.npm === undefined ? "hermes-agent" : overrides.npm,
          brew: null,
        },
        config_paths: ["~/.hermes/config.yaml"],
        config_snippet: null,
        required_secrets: [],
        optional_secrets: [],
        mcp_compatible: true,
        supported_versions: overrides.supported ?? ">=2.0.0, <3.0.0",
        min_foreman_version: "0.1.2",
      },
    ],
  };
}

function hermesAgent(overrides: { registryId?: string | null } = {}): {
  id: string;
  displayName: string;
  metadata: Record<string, unknown> | null;
} {
  const meta: Record<string, unknown> = {};
  if (overrides.registryId !== null) {
    meta.registryId = overrides.registryId ?? "hermes";
  }
  return {
    id: "hermes",
    displayName: "Hermes",
    metadata: overrides.registryId === null ? null : meta,
  };
}

function fakeFetch(version: string, status = 200): typeof fetch {
  const fn = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ version }),
  })) as unknown as typeof fetch;
  return fn;
}

describe("parseSupportedRangeUpperBound", () => {
  it.each([
    [">=2.0.0, <3.0.0", "3.0.0"],
    [">=2.0.0,<3.0.0", "3.0.0"],
    [">=2.0.0 <3.5.1", "3.5.1"],
    [">=2.0.0", null],
    ["", null],
    ["garbage", null],
  ])("parseSupportedRangeUpperBound(%j) === %j", (input, expected) => {
    expect(parseSupportedRangeUpperBound(input)).toBe(expected);
  });
});

describe("isOvershoot", () => {
  it.each([
    ["3.0.0", ">=2.0.0, <3.0.0", true],
    ["3.1.0", ">=2.0.0, <3.0.0", true],
    ["2.9.9", ">=2.0.0, <3.0.0", false],
    ["1.9.9", ">=2.0.0, <3.0.0", false],
    ["5.0.0", ">=2.0.0", false],
    [null, ">=2.0.0, <3.0.0", false],
  ] as const)("isOvershoot(%j, %j) === %j", (installed, range, expected) => {
    expect(isOvershoot(installed, range)).toBe(expected);
  });
});

describe("getInstalledNpmVersion", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "foreman-aup-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads <prefix>/lib/node_modules/<pkg>/package.json", () => {
    const pkgDir = resolve(tmpDir, "lib", "node_modules", "hermes-agent");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      resolve(pkgDir, "package.json"),
      JSON.stringify({ name: "hermes-agent", version: "2.0.3" }),
    );
    expect(getInstalledNpmVersion("hermes-agent", { npmPrefix: tmpDir })).toBe(
      "2.0.3",
    );
  });

  it("falls back to <prefix>/node_modules/<pkg>/package.json (Windows layout)", () => {
    const pkgDir = resolve(tmpDir, "node_modules", "openclaw");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      resolve(pkgDir, "package.json"),
      JSON.stringify({ version: "1.4.2" }),
    );
    expect(getInstalledNpmVersion("openclaw", { npmPrefix: tmpDir })).toBe(
      "1.4.2",
    );
  });

  it("returns null when the package isn't installed", () => {
    expect(
      getInstalledNpmVersion("ghost-agent", { npmPrefix: tmpDir }),
    ).toBeNull();
  });

  it("returns null when package.json is malformed", () => {
    const pkgDir = resolve(tmpDir, "lib", "node_modules", "broken");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(resolve(pkgDir, "package.json"), "{ not json");
    expect(getInstalledNpmVersion("broken", { npmPrefix: tmpDir })).toBeNull();
  });

  it("returns null when npm prefix is null", () => {
    expect(getInstalledNpmVersion("anything", { npmPrefix: null })).toBeNull();
  });
});

describe("checkAgentUpdates", () => {
  let cacheDir: string;
  let savedSkip: string | undefined;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "foreman-aup-cache-"));
    savedSkip = process.env.FOREMAN_NO_AGENT_UPDATE_CHECK;
    delete process.env.FOREMAN_NO_AGENT_UPDATE_CHECK;
  });

  afterEach(() => {
    if (savedSkip === undefined)
      delete process.env.FOREMAN_NO_AGENT_UPDATE_CHECK;
    else process.env.FOREMAN_NO_AGENT_UPDATE_CHECK = savedSkip;
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("returns [] when FOREMAN_NO_AGENT_UPDATE_CHECK=1", async () => {
    process.env.FOREMAN_NO_AGENT_UPDATE_CHECK = "1";
    const result = await checkAgentUpdates([hermesAgent()], makeRegistry(), {
      cacheDir,
      fetchFn: fakeFetch("9.9.9"),
      resolveInstalledVersion: () => "2.0.3",
    });
    expect(result).toEqual([]);
  });

  it("flags hasUpdate when registry latest is newer than installed", async () => {
    const result = await checkAgentUpdates([hermesAgent()], makeRegistry(), {
      cacheDir,
      fetchFn: fakeFetch("2.1.0"),
      resolveInstalledVersion: () => "2.0.3",
    });
    expect(result).toHaveLength(1);
    const status = result[0]!;
    expect(status.hasUpdate).toBe(true);
    expect(status.current).toBe("2.0.3");
    expect(status.latest).toBe("2.1.0");
    expect(status.source).toBe("network");
    expect(status.isOvershoot).toBe(false);
    expect(status.error).toBeUndefined();
    expect(existsSync(resolve(cacheDir, "hermes.json"))).toBe(true);
  });

  it("hasUpdate=false when installed is already at latest", async () => {
    const result = await checkAgentUpdates([hermesAgent()], makeRegistry(), {
      cacheDir,
      fetchFn: fakeFetch("2.1.0"),
      resolveInstalledVersion: () => "2.1.0",
    });
    expect(result[0]?.hasUpdate).toBe(false);
  });

  it("flags isOvershoot when installed is past the supported upper bound", async () => {
    const result = await checkAgentUpdates([hermesAgent()], makeRegistry(), {
      cacheDir,
      fetchFn: fakeFetch("3.0.0"),
      resolveInstalledVersion: () => "3.0.0",
    });
    expect(result[0]?.isOvershoot).toBe(true);
  });

  it("reads from cache on second call", async () => {
    await checkAgentUpdates([hermesAgent()], makeRegistry(), {
      cacheDir,
      fetchFn: fakeFetch("2.1.0"),
      resolveInstalledVersion: () => "2.0.3",
    });
    const second = await checkAgentUpdates([hermesAgent()], makeRegistry(), {
      cacheDir,
      fetchFn: (() => {
        throw new Error("network should not be hit");
      }) as unknown as typeof fetch,
      resolveInstalledVersion: () => "2.0.3",
    });
    expect(second[0]?.source).toBe("cache");
    expect(second[0]?.latest).toBe("2.1.0");
  });

  it("returns network-error status on fetch failure (never throws)", async () => {
    const fn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await checkAgentUpdates([hermesAgent()], makeRegistry(), {
      cacheDir,
      fetchFn: fn,
      resolveInstalledVersion: () => "2.0.3",
    });
    expect(result[0]?.error).toBe("network-error");
    expect(result[0]?.hasUpdate).toBe(false);
  });

  it("returns network-error when registry returns non-2xx", async () => {
    const result = await checkAgentUpdates([hermesAgent()], makeRegistry(), {
      cacheDir,
      fetchFn: fakeFetch("2.1.0", 503),
      resolveInstalledVersion: () => "2.0.3",
    });
    expect(result[0]?.error).toBe("network-error");
  });

  it("flags install-version-unknown when the binary version can't be read", async () => {
    const result = await checkAgentUpdates([hermesAgent()], makeRegistry(), {
      cacheDir,
      fetchFn: fakeFetch("2.1.0"),
      resolveInstalledVersion: () => null,
    });
    expect(result[0]?.error).toBe("install-version-unknown");
    expect(result[0]?.hasUpdate).toBe(false);
    expect(result[0]?.latest).toBe("2.1.0");
  });

  it("flags no-registry-entry when the agent has no registryId metadata", async () => {
    const result = await checkAgentUpdates(
      [hermesAgent({ registryId: null })],
      makeRegistry(),
      { cacheDir },
    );
    expect(result[0]?.error).toBe("no-registry-entry");
  });

  it("flags no-registry-entry when the registryId doesn't match any entry", async () => {
    const result = await checkAgentUpdates(
      [hermesAgent({ registryId: "ghost" })],
      makeRegistry(),
      { cacheDir },
    );
    expect(result[0]?.error).toBe("no-registry-entry");
  });

  it("flags no-npm-pkg when the registry entry has no npm install command", async () => {
    const result = await checkAgentUpdates(
      [hermesAgent()],
      makeRegistry({ npm: null }),
      { cacheDir, fetchFn: fakeFetch("2.1.0") },
    );
    expect(result[0]?.error).toBe("no-npm-pkg");
  });

  it("refreshes from network when the cache is older than the TTL", async () => {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      resolve(cacheDir, "hermes.json"),
      JSON.stringify({
        latest: "0.0.1",
        observedAt: Date.now() - 25 * 60 * 60 * 1000,
      }),
    );
    const result = await checkAgentUpdates([hermesAgent()], makeRegistry(), {
      cacheDir,
      fetchFn: fakeFetch("2.1.0"),
      resolveInstalledVersion: () => "2.0.3",
    });
    expect(result[0]?.source).toBe("network");
    expect(result[0]?.latest).toBe("2.1.0");
    const cache = JSON.parse(
      readFileSync(resolve(cacheDir, "hermes.json"), "utf8"),
    );
    expect(cache.latest).toBe("2.1.0");
  });
});
