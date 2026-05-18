import { describe, expect, it } from "vitest";
import { detectMachineCapability } from "../../src/core/machine-capability.js";
import {
  canRunModel,
  loadOllamaModels,
  _resetOllamaModelsCache,
} from "../../src/core/ollama-models.js";

const GB = 1024 ** 3;

function tinyMachine() {
  return detectMachineCapability({
    osOverride: "linux",
    archOverride: "x86_64",
    totalRamBytesOverride: 8 * GB,
    freeRamBytesOverride: 5 * GB,
    freeDiskBytesOverride: 100 * GB,
    cpuCountOverride: 4,
    gpuOverride: { kind: "none", vramBytes: null },
  });
}

function mediumMachine() {
  return detectMachineCapability({
    osOverride: "darwin",
    archOverride: "arm64",
    totalRamBytesOverride: 16 * GB,
    freeRamBytesOverride: 12 * GB,
    freeDiskBytesOverride: 200 * GB,
    cpuCountOverride: 12,
    gpuOverride: { kind: "apple-metal", vramBytes: null },
  });
}

function workstationMachine() {
  return detectMachineCapability({
    osOverride: "linux",
    archOverride: "x86_64",
    totalRamBytesOverride: 128 * GB,
    freeRamBytesOverride: 110 * GB,
    freeDiskBytesOverride: 1000 * GB,
    cpuCountOverride: 32,
    gpuOverride: { kind: "nvidia-cuda", vramBytes: 48 * GB },
  });
}

describe("loadOllamaModels", () => {
  it("loads the bundled registry with the expected popular models", () => {
    _resetOllamaModelsCache();
    const doc = loadOllamaModels();
    expect(doc.version).toBe(1);
    expect(doc.models.length).toBeGreaterThanOrEqual(15);
    const names = doc.models.map((m) => m.name);
    expect(names).toContain("llama3.2:3b");
    expect(names).toContain("qwen2.5:7b");
    expect(names).toContain("deepseek-r1:8b");
    expect(names).toContain("llama3.1:70b");
  });

  it("marks at least one model as recommended", () => {
    _resetOllamaModelsCache();
    const doc = loadOllamaModels();
    expect(doc.models.some((m) => m.recommended)).toBe(true);
  });

  it("caches the parsed registry on second call", () => {
    _resetOllamaModelsCache();
    const a = loadOllamaModels();
    const b = loadOllamaModels();
    expect(a).toBe(b);
  });
});

describe("canRunModel", () => {
  const models = loadOllamaModels().models;
  const tiny3b = models.find((m) => m.name === "llama3.2:3b")!;
  const seven_b = models.find((m) => m.name === "llama3.1:8b")!;
  const big14b = models.find((m) => m.name === "qwen2.5:14b")!;
  const huge70b = models.find((m) => m.name === "llama3.1:70b")!;

  it("marks a 3 GB model as recommended on a 16 GB Mac", () => {
    const status = canRunModel(tiny3b, mediumMachine());
    expect(status.state).toBe("recommended");
  });

  it("marks an 8 GB model as balanced on a 16 GB Mac", () => {
    const status = canRunModel(seven_b, mediumMachine());
    expect(["recommended", "balanced"]).toContain(status.state);
  });

  it("marks a 14 GB-ish model as tight or disabled on a 16 GB Mac", () => {
    const status = canRunModel(big14b, mediumMachine());
    expect(["tight", "disabled-ram"]).toContain(status.state);
  });

  it("disables a 70B model on a 16 GB Mac with a clear reason", () => {
    const status = canRunModel(huge70b, mediumMachine());
    expect(status.state).toBe("disabled-ram");
    if (status.state === "disabled-ram") {
      expect(status.reason).toMatch(/GB/);
    }
  });

  it("happily runs the 70B model on a 128 GB workstation", () => {
    const status = canRunModel(huge70b, workstationMachine());
    expect(["recommended", "balanced", "tight"]).toContain(status.state);
  });

  it("hides oversize models on an 8 GB box (disabled-ram)", () => {
    const status = canRunModel(seven_b, tinyMachine());
    expect(["balanced", "tight", "disabled-ram"]).toContain(status.state);
  });

  it("returns disabled-disk when free disk is below download size", () => {
    const stingy = detectMachineCapability({
      osOverride: "linux",
      archOverride: "x86_64",
      totalRamBytesOverride: 64 * GB,
      freeRamBytesOverride: 50 * GB,
      freeDiskBytesOverride: 1 * GB, // less than a 2 GB pull
      cpuCountOverride: 8,
      gpuOverride: { kind: "nvidia-cuda", vramBytes: 16 * GB },
    });
    const status = canRunModel(tiny3b, stingy);
    expect(status.state).toBe("disabled-disk");
    if (status.state === "disabled-disk") {
      expect(status.reason).toMatch(/download/i);
    }
  });

  it("ignores disk gate when freeDiskBytesHome is null", () => {
    const noDiskInfo = detectMachineCapability({
      osOverride: "linux",
      archOverride: "x86_64",
      totalRamBytesOverride: 32 * GB,
      freeRamBytesOverride: 24 * GB,
      freeDiskBytesOverride: null,
      cpuCountOverride: 8,
      gpuOverride: { kind: "none", vramBytes: null },
    });
    const status = canRunModel(tiny3b, noDiskInfo);
    expect(status.state).toBe("recommended");
  });
});
