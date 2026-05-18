import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectOllama,
  parseOllamaList,
} from "../../src/core/ollama-detector.js";

describe("parseOllamaList", () => {
  it("returns names from the standard `ollama list` table", () => {
    const out = parseOllamaList(
      [
        "NAME                ID              SIZE      MODIFIED",
        "llama3.2:3b         abc123          2.0 GB    2 hours ago",
        "qwen2.5:7b          def456          4.7 GB    1 day ago",
      ].join("\n"),
    );
    expect(out).toEqual(["llama3.2:3b", "qwen2.5:7b"]);
  });

  it("returns [] for an empty list (header only)", () => {
    expect(parseOllamaList("NAME ID SIZE MODIFIED\n")).toEqual([]);
  });

  it("returns [] for empty input", () => {
    expect(parseOllamaList("")).toEqual([]);
  });

  it("skips blank lines + extra whitespace", () => {
    const out = parseOllamaList(
      "\n\n  llama3.2:3b   abc   2.0 GB   now\n\n",
    );
    expect(out).toEqual(["llama3.2:3b"]);
  });
});

describe("detectOllama", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "foreman-ollama-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns installed:false when ollama is not on PATH", () => {
    const result = detectOllama({ env: { PATH: "/nonexistent" } });
    expect(result.installed).toBe(false);
    expect(result.version).toBeNull();
    expect(result.serviceReachable).toBe(false);
    expect(result.installedModels).toEqual([]);
  });

  it("returns installed:true + version when binary exists + version exec works", () => {
    const binDir = join(tmp, "bin");
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, "ollama");
    writeFileSync(binPath, "#!/bin/sh\n");
    chmodSync(binPath, 0o755);
    const exec = vi.fn((cmd: string, args: readonly string[]) => {
      if (args[0] === "--version") return "ollama version is 0.4.6\n";
      if (args[0] === "list") {
        return [
          "NAME           ID    SIZE   MODIFIED",
          "llama3.2:3b    abc   2.0GB  now",
        ].join("\n");
      }
      throw new Error("unknown");
    });
    const result = detectOllama({ env: { PATH: binDir }, exec });
    expect(result.installed).toBe(true);
    expect(result.version).toBe("ollama version is 0.4.6");
    expect(result.binaryPath).toBe(binPath);
    expect(result.serviceReachable).toBe(true);
    expect(result.installedModels).toEqual(["llama3.2:3b"]);
  });

  it("returns serviceReachable:false when `ollama list` throws (service not running)", () => {
    const binDir = join(tmp, "bin");
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, "ollama");
    writeFileSync(binPath, "#!/bin/sh\n");
    chmodSync(binPath, 0o755);
    const exec = vi.fn((cmd: string, args: readonly string[]) => {
      if (args[0] === "--version") return "ollama version is 0.4.6\n";
      throw new Error("connection refused");
    });
    const result = detectOllama({ env: { PATH: binDir }, exec });
    expect(result.installed).toBe(true);
    expect(result.serviceReachable).toBe(false);
    expect(result.installedModels).toEqual([]);
  });

  it("survives a --version failure without crashing (rare)", () => {
    const binDir = join(tmp, "bin");
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, "ollama");
    writeFileSync(binPath, "#!/bin/sh\n");
    chmodSync(binPath, 0o755);
    const exec = vi.fn((cmd: string, args: readonly string[]) => {
      if (args[0] === "--version") throw new Error("permission denied");
      return "";
    });
    const result = detectOllama({ env: { PATH: binDir }, exec });
    expect(result.installed).toBe(true);
    expect(result.version).toBeNull();
  });
});
