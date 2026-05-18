import { sign } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fetchAndInstallRegistry,
  getRegistryStatus,
  rollbackRegistry,
} from "../../src/core/registry-fetch.js";
import {
  generateKeypair,
  privateKeyObjectFromRaw,
} from "../../src/identity/keypair.js";

// =============================================================================
// #421 — Signed remote registry fetch. Exercises:
//   - Signature verify with a configured public key
//   - --insecure-no-verify path
//   - Schema validation refuses bad input
//   - Atomic install + backup (.bak)
//   - Rollback restores .bak
//   - Status reflects on-disk state
// =============================================================================

function signBody(body: Buffer, privateKey: Buffer): string {
  return Buffer.from(
    sign(null, body, privateKeyObjectFromRaw(privateKey)),
  ).toString("hex");
}

const validRegistry = JSON.stringify({
  version: 1,
  agents: [
    {
      id: "hermes",
      name: "Hermes",
      tagline: "test",
      homepage: "https://example.com/",
      install: { npm: null, brew: null },
      config_paths: [],
      required_secrets: [],
      optional_secrets: [],
      mcp_compatible: true,
      supported_versions: ">=2.0.0",
      min_foreman_version: "0.1.2",
    },
  ],
});

function makeFetchImpl(responses: Record<string, Buffer | { status: number }>) {
  return async (
    url: string,
  ): Promise<{
    ok: boolean;
    status: number;
    body: Buffer;
    statusText?: string;
  }> => {
    const r = responses[url];
    if (r === undefined) {
      return { ok: false, status: 404, body: Buffer.alloc(0) };
    }
    if (Buffer.isBuffer(r)) {
      return { ok: true, status: 200, body: r };
    }
    return { ok: false, status: r.status, body: Buffer.alloc(0) };
  };
}

describe("fetchAndInstallRegistry — secure path", () => {
  let tmp: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "foreman-registry-"));
    previousHome = process.env.FOREMAN_HOME;
    process.env.FOREMAN_HOME = tmp;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.FOREMAN_HOME;
    else process.env.FOREMAN_HOME = previousHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("verifies signature + installs the registry when signed correctly", async () => {
    const kp = generateKeypair();
    const body = Buffer.from(validRegistry, "utf-8");
    const sigHex = signBody(body, kp.privateKey);
    const pkPath = join(tmp, "registry-pubkey.hex");
    writeFileSync(pkPath, kp.publicKey.toString("hex"), "utf-8");
    const cachePath = join(tmp, "cache", "registry.json");

    const result = await fetchAndInstallRegistry({
      url: "https://example.com/registry.json",
      publicKeyPath: pkPath,
      cachePath,
      fetchImpl: makeFetchImpl({
        "https://example.com/registry.json": body,
        "https://example.com/registry.json.sig": Buffer.from(sigHex, "utf-8"),
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.signatureVerified).toBe(true);
    expect(result.doc?.agents).toHaveLength(1);
    expect(existsSync(cachePath)).toBe(true);
  });

  it("refuses when no public key is configured and --insecure-no-verify is off", async () => {
    const result = await fetchAndInstallRegistry({
      url: "https://example.com/registry.json",
      publicKeyPath: join(tmp, "no-such-key.hex"),
      cachePath: join(tmp, "cache", "registry.json"),
      fetchImpl: makeFetchImpl({
        "https://example.com/registry.json": Buffer.from(validRegistry, "utf-8"),
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no registry public key/);
  });

  it("rejects a tampered body with a recognisable error", async () => {
    const kp = generateKeypair();
    const original = Buffer.from(validRegistry, "utf-8");
    const sigHex = signBody(original, kp.privateKey);
    const tampered = Buffer.from(
      validRegistry.replace("Hermes", "Evil"),
      "utf-8",
    );
    const pkPath = join(tmp, "registry-pubkey.hex");
    writeFileSync(pkPath, kp.publicKey.toString("hex"), "utf-8");

    const result = await fetchAndInstallRegistry({
      url: "https://example.com/registry.json",
      publicKeyPath: pkPath,
      cachePath: join(tmp, "cache", "registry.json"),
      fetchImpl: makeFetchImpl({
        "https://example.com/registry.json": tampered, // tampered body
        "https://example.com/registry.json.sig": Buffer.from(sigHex, "utf-8"),
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/signature verification failed/);
  });

  it("rejects a registry whose schema validation fails", async () => {
    const kp = generateKeypair();
    const badRegistry = Buffer.from(
      '{"version":1,"agents":[{"id":"invalid id with spaces"}]}',
      "utf-8",
    );
    const sigHex = signBody(badRegistry, kp.privateKey);
    const pkPath = join(tmp, "registry-pubkey.hex");
    writeFileSync(pkPath, kp.publicKey.toString("hex"), "utf-8");

    const result = await fetchAndInstallRegistry({
      url: "https://example.com/registry.json",
      publicKeyPath: pkPath,
      cachePath: join(tmp, "cache", "registry.json"),
      fetchImpl: makeFetchImpl({
        "https://example.com/registry.json": badRegistry,
        "https://example.com/registry.json.sig": Buffer.from(sigHex, "utf-8"),
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/registry parse failed|schema/);
  });

  it("propagates HTTP errors from the body fetch", async () => {
    const pkPath = join(tmp, "registry-pubkey.hex");
    writeFileSync(pkPath, "00".repeat(32), "utf-8");
    const result = await fetchAndInstallRegistry({
      url: "https://example.com/registry.json",
      publicKeyPath: pkPath,
      cachePath: join(tmp, "cache", "registry.json"),
      fetchImpl: makeFetchImpl({
        "https://example.com/registry.json": { status: 404 },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/404/);
  });
});

describe("fetchAndInstallRegistry — insecure path", () => {
  let tmp: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "foreman-registry-"));
    previousHome = process.env.FOREMAN_HOME;
    process.env.FOREMAN_HOME = tmp;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.FOREMAN_HOME;
    else process.env.FOREMAN_HOME = previousHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("installs without fetching .sig when allowInsecure=true", async () => {
    const cachePath = join(tmp, "cache", "registry.json");
    const result = await fetchAndInstallRegistry({
      url: "https://example.com/registry.json",
      allowInsecure: true,
      cachePath,
      fetchImpl: makeFetchImpl({
        "https://example.com/registry.json": Buffer.from(validRegistry, "utf-8"),
        // intentionally no .sig response — would 404
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.signatureVerified).toBe(false);
    expect(existsSync(cachePath)).toBe(true);
  });

  it("still schema-validates in insecure mode (refuses garbage)", async () => {
    const result = await fetchAndInstallRegistry({
      url: "https://example.com/registry.json",
      allowInsecure: true,
      cachePath: join(tmp, "cache", "registry.json"),
      fetchImpl: makeFetchImpl({
        "https://example.com/registry.json": Buffer.from("not-json", "utf-8"),
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/registry parse failed|JSON/);
  });
});

describe("fetchAndInstallRegistry — atomic install + backup", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "foreman-registry-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("backs up the existing cache before overwriting", async () => {
    const cachePath = join(tmp, "registry.json");
    // Seed an existing cache.
    writeFileSync(
      cachePath,
      JSON.stringify({ version: 1, agents: [], old: true }),
      "utf-8",
    );
    const result = await fetchAndInstallRegistry({
      url: "https://example.com/registry.json",
      allowInsecure: true,
      cachePath,
      fetchImpl: makeFetchImpl({
        "https://example.com/registry.json": Buffer.from(validRegistry, "utf-8"),
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.backedUp).toBe(true);
    expect(existsSync(cachePath + ".bak")).toBe(true);
    const backup = JSON.parse(readFileSync(cachePath + ".bak", "utf-8"));
    expect(backup.old).toBe(true);
  });

  it("does NOT create a .bak when no existing cache to back up", async () => {
    const cachePath = join(tmp, "registry.json");
    const result = await fetchAndInstallRegistry({
      url: "https://example.com/registry.json",
      allowInsecure: true,
      cachePath,
      fetchImpl: makeFetchImpl({
        "https://example.com/registry.json": Buffer.from(validRegistry, "utf-8"),
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.backedUp).toBe(false);
    expect(existsSync(cachePath + ".bak")).toBe(false);
  });
});

describe("rollbackRegistry", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "foreman-registry-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("restores the .bak file when present", () => {
    const cachePath = join(tmp, "registry.json");
    writeFileSync(cachePath, '{"version":1,"agents":[],"current":true}', "utf-8");
    writeFileSync(
      cachePath + ".bak",
      '{"version":1,"agents":[],"previous":true}',
      "utf-8",
    );
    const result = rollbackRegistry(cachePath);
    expect(result.ok).toBe(true);
    const restored = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(restored.previous).toBe(true);
    expect(existsSync(cachePath + ".bak")).toBe(false); // consumed
  });

  it("returns ok=false with a clear reason when no .bak exists", () => {
    const cachePath = join(tmp, "registry.json");
    const result = rollbackRegistry(cachePath);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/nothing to roll back/);
  });
});

describe("getRegistryStatus", () => {
  let tmp: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "foreman-registry-"));
    previousHome = process.env.FOREMAN_HOME;
    process.env.FOREMAN_HOME = tmp;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.FOREMAN_HOME;
    else process.env.FOREMAN_HOME = previousHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reports cache state and rollback availability", () => {
    let status = getRegistryStatus();
    expect(status.cached).toBe(false);
    expect(status.hasBackup).toBe(false);

    // Seed cache + bak via direct write (using the actual cache path).
    // Foreman's cache lives under a nested dir — ensure it exists.
    mkdirSync(dirname(status.cachePath), { recursive: true });
    writeFileSync(
      status.cachePath,
      JSON.stringify({ version: 1, agents: [] }),
      "utf-8",
    );
    writeFileSync(
      status.cachePath + ".bak",
      JSON.stringify({ version: 1, agents: [] }),
      "utf-8",
    );

    status = getRegistryStatus();
    expect(status.cached).toBe(true);
    expect(status.hasBackup).toBe(true);
    expect(status.version).toBe(1);
    expect(status.agentCount).toBe(0);
  });

  it("reports hasPublicKey accurately", () => {
    const status1 = getRegistryStatus();
    expect(status1.hasPublicKey).toBe(false);
    mkdirSync(dirname(status1.publicKeyPath), { recursive: true });
    writeFileSync(status1.publicKeyPath, "00".repeat(32), "utf-8");
    const status2 = getRegistryStatus();
    expect(status2.hasPublicKey).toBe(true);
  });
});
