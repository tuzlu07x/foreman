import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  planOllamaInstall,
  runOllamaInstall,
} from "../../src/core/ollama-installer.js";

describe("planOllamaInstall", () => {
  it("uses brew on macOS", () => {
    const plan = planOllamaInstall("darwin");
    expect(plan.command).toContain("brew install ollama");
    expect(plan.command).toContain("brew services start ollama");
  });

  it("uses the official curl|bash on Linux", () => {
    const plan = planOllamaInstall("linux");
    expect(plan.command).toContain("curl -fsSL https://ollama.com/install.sh");
  });

  it("returns null command on Windows (manual install path)", () => {
    const plan = planOllamaInstall("win32");
    expect(plan.command).toBeNull();
    expect(plan.manualUrl).toContain("ollama.com");
  });

  it("returns null command for unsupported OS", () => {
    const plan = planOllamaInstall("other");
    expect(plan.command).toBeNull();
  });
});

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe("runOllamaInstall", () => {
  it("returns ok:true when the install exits 0", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child) as never;
    const promise = runOllamaInstall({
      plan: planOllamaInstall("darwin"),
      spawnImpl,
    });
    child.stdout.emit("data", Buffer.from("==> Installing ollama\n"));
    child.emit("close", 0);
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("returns ok:false when the install exits non-zero", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child) as never;
    const promise = runOllamaInstall({
      plan: planOllamaInstall("linux"),
      spawnImpl,
    });
    child.stderr.emit("data", Buffer.from("E: package not found\n"));
    child.emit("close", 1);
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("times out + SIGKILLs after the idle period with no output", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const spawnImpl = vi.fn(() => child) as never;
      const promise = runOllamaInstall({
        plan: planOllamaInstall("linux"),
        spawnImpl,
        idleTimeoutMs: 100,
      });
      // Watchdog ticks every 5s — advance past one tick so it sees
      // last-output is older than our 100ms idle limit, then trigger
      // the close that the SIGKILL produces.
      await vi.advanceTimersByTimeAsync(6_000);
      child.emit("close", null);
      const result = await promise;
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(result.ok).toBe(false);
      expect(result.manualCommand).toMatch(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null-command result when plan has no command (Windows)", async () => {
    const result = await runOllamaInstall({
      plan: planOllamaInstall("win32"),
    });
    expect(result.ok).toBe(false);
    expect(result.manualCommand).toMatch(/no automated install/);
  });

  it("forwards stdout/stderr lines to onLine", async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child) as never;
    const lines: string[] = [];
    const promise = runOllamaInstall({
      plan: planOllamaInstall("darwin"),
      spawnImpl,
      onLine: (l) => lines.push(l),
    });
    child.stdout.emit("data", Buffer.from("line one\nline two\n"));
    child.stderr.emit("data", Buffer.from("warning: foo\n"));
    child.emit("close", 0);
    await promise;
    expect(lines).toContain("line one");
    expect(lines).toContain("line two");
    expect(lines).toContain("warning: foo");
  });
});
