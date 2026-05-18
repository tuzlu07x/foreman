import { describe, expect, it } from "vitest";
import {
  bytesToGb,
  detectMachineCapability,
  usableInferenceRamBytes,
} from "../../src/core/machine-capability.js";

const GB = 1024 ** 3;

describe("detectMachineCapability", () => {
  it("returns the real machine's snapshot when no overrides are passed", () => {
    const cap = detectMachineCapability();
    expect(["darwin", "linux", "win32", "other"]).toContain(cap.os);
    expect(["arm64", "x86_64", "other"]).toContain(cap.arch);
    expect(cap.totalRamBytes).toBeGreaterThan(0);
    expect(cap.cpuCount).toBeGreaterThan(0);
  });

  it("respects ram + disk + os overrides for tests", () => {
    const cap = detectMachineCapability({
      osOverride: "linux",
      archOverride: "x86_64",
      totalRamBytesOverride: 16 * GB,
      freeRamBytesOverride: 12 * GB,
      freeDiskBytesOverride: 200 * GB,
      cpuCountOverride: 8,
      gpuOverride: { kind: "nvidia-cuda", vramBytes: 24 * GB },
    });
    expect(cap.os).toBe("linux");
    expect(cap.arch).toBe("x86_64");
    expect(cap.totalRamBytes).toBe(16 * GB);
    expect(cap.freeRamBytes).toBe(12 * GB);
    expect(cap.freeDiskBytesHome).toBe(200 * GB);
    expect(cap.cpuCount).toBe(8);
    expect(cap.gpu.kind).toBe("nvidia-cuda");
    expect(cap.gpu.vramBytes).toBe(24 * GB);
  });

  it("treats Apple Silicon as Metal unified memory by default", () => {
    const cap = detectMachineCapability({
      osOverride: "darwin",
      archOverride: "arm64",
      totalRamBytesOverride: 16 * GB,
      freeRamBytesOverride: 8 * GB,
      freeDiskBytesOverride: 100 * GB,
      cpuCountOverride: 12,
      // No gpuOverride → real detector kicks in. On darwin we hardcode
      // apple-metal so the test is deterministic regardless of host.
    });
    expect(cap.gpu.kind).toBe("apple-metal");
    // Unified memory — VRAM matches null (treat as system RAM).
    expect(cap.gpu.vramBytes).toBeNull();
  });
});

describe("bytesToGb", () => {
  it("converts bytes to GB", () => {
    expect(bytesToGb(GB)).toBe(1);
    expect(bytesToGb(16 * GB)).toBe(16);
  });
});

describe("usableInferenceRamBytes", () => {
  it("returns total minus 4 GB headroom by default when free RAM is lower", () => {
    const cap = detectMachineCapability({
      osOverride: "darwin",
      archOverride: "arm64",
      totalRamBytesOverride: 16 * GB,
      freeRamBytesOverride: 6 * GB,
      freeDiskBytesOverride: 100 * GB,
      cpuCountOverride: 12,
      gpuOverride: { kind: "apple-metal", vramBytes: null },
    });
    // total - 4 = 12 GB optimistic ceiling. free is only 6 GB. We return
    // max(free, optimistic) = 12 GB so closing apps unlocks bigger models.
    expect(usableInferenceRamBytes(cap)).toBe(12 * GB);
  });

  it("returns free RAM when it's larger than total-minus-headroom", () => {
    // Edge case — free briefly reports higher than total-headroom because
    // process accounting is fuzzy. Still pick the larger value.
    const cap = detectMachineCapability({
      osOverride: "linux",
      archOverride: "x86_64",
      totalRamBytesOverride: 8 * GB,
      freeRamBytesOverride: 7 * GB,
      freeDiskBytesOverride: 100 * GB,
      cpuCountOverride: 4,
      gpuOverride: { kind: "none", vramBytes: null },
    });
    // total - 4 = 4 GB; free = 7 GB → use free
    expect(usableInferenceRamBytes(cap)).toBe(7 * GB);
  });

  it("never returns a negative value (small box edge case)", () => {
    const cap = detectMachineCapability({
      osOverride: "linux",
      archOverride: "x86_64",
      totalRamBytesOverride: 2 * GB,
      freeRamBytesOverride: 0.5 * GB,
      freeDiskBytesOverride: 10 * GB,
      cpuCountOverride: 2,
      gpuOverride: { kind: "none", vramBytes: null },
    });
    // total - 4GB headroom = negative → clamp to 0; free = 0.5 GB → use free
    expect(usableInferenceRamBytes(cap)).toBe(0.5 * GB);
  });

  it("custom headroom override", () => {
    const cap = detectMachineCapability({
      osOverride: "linux",
      archOverride: "x86_64",
      totalRamBytesOverride: 16 * GB,
      freeRamBytesOverride: 1 * GB,
      freeDiskBytesOverride: 100 * GB,
      cpuCountOverride: 8,
      gpuOverride: { kind: "none", vramBytes: null },
    });
    expect(usableInferenceRamBytes(cap, 2 * GB)).toBe(14 * GB);
  });
});
