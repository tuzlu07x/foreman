import { describe, expect, it } from "vitest";
import { openInBrowser } from "../../src/utils/browser-open.js";

// =============================================================================
// #408 / #413 Phase 5 — cross-platform browser opener. Used by the wizard's
// required-setup step ([o] keypress) to open key-acquisition URLs.
// =============================================================================

function makeExecSpy(): {
  exec: (
    cmd: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string }>;
  calls: { cmd: string; args: string[] }[];
} {
  const calls: { cmd: string; args: string[] }[] = [];
  const exec = async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return { stdout: "", stderr: "" };
  };
  return { exec, calls };
}

function makeFailingExec(): (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }> {
  return async () => {
    throw new Error("command not found");
  };
}

describe("openInBrowser — URL validation", () => {
  it("rejects non-http(s) protocols", async () => {
    const r = await openInBrowser("file:///etc/passwd", {
      platformOverride: "darwin",
      execImpl: makeExecSpy().exec,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/protocol/);
  });

  it("rejects javascript: URLs", async () => {
    const r = await openInBrowser("javascript:alert(1)", {
      platformOverride: "darwin",
      execImpl: makeExecSpy().exec,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects malformed URLs", async () => {
    const r = await openInBrowser("not-a-url", {
      platformOverride: "darwin",
      execImpl: makeExecSpy().exec,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/invalid URL/);
  });

  it("accepts https URLs", async () => {
    const spy = makeExecSpy();
    const r = await openInBrowser("https://openrouter.ai/keys", {
      platformOverride: "darwin",
      execImpl: spy.exec,
    });
    expect(r.ok).toBe(true);
  });

  it("accepts http URLs (some legacy acquisition pages)", async () => {
    const spy = makeExecSpy();
    const r = await openInBrowser("http://localhost:8080/auth", {
      platformOverride: "darwin",
      execImpl: spy.exec,
    });
    expect(r.ok).toBe(true);
  });
});

describe("openInBrowser — platform dispatch", () => {
  it("darwin uses `open` with the URL as the sole arg", async () => {
    const spy = makeExecSpy();
    const r = await openInBrowser("https://example.com", {
      platformOverride: "darwin",
      execImpl: spy.exec,
    });
    expect(r.ok).toBe(true);
    expect(r.handler).toBe("darwin");
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.cmd).toBe("open");
    expect(spy.calls[0]?.args).toEqual(["https://example.com"]);
  });

  it("linux tries xdg-open first", async () => {
    const spy = makeExecSpy();
    const r = await openInBrowser("https://example.com", {
      platformOverride: "linux",
      execImpl: spy.exec,
    });
    expect(r.ok).toBe(true);
    expect(r.handler).toBe("linux-xdg");
    expect(spy.calls[0]?.cmd).toBe("xdg-open");
  });

  it("linux falls back to gnome-open when xdg-open is missing", async () => {
    let xdgFailed = false;
    const exec = async (cmd: string, args: string[]) => {
      if (cmd === "xdg-open") {
        xdgFailed = true;
        throw new Error("xdg-open: not found");
      }
      return { stdout: "", stderr: "" };
    };
    const r = await openInBrowser("https://example.com", {
      platformOverride: "linux",
      execImpl: exec,
    });
    expect(xdgFailed).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.handler).toBe("linux-gnome");
  });

  it("linux returns ok=false when both xdg-open and gnome-open fail", async () => {
    const r = await openInBrowser("https://example.com", {
      platformOverride: "linux",
      execImpl: makeFailingExec(),
    });
    expect(r.ok).toBe(false);
    expect(r.handler).toBe("linux-xdg");
    expect(r.reason).toMatch(/xdg-open \+ gnome-open both failed/);
  });

  it("win32 wraps the URL via cmd /c start", async () => {
    const spy = makeExecSpy();
    const r = await openInBrowser("https://example.com", {
      platformOverride: "win32",
      execImpl: spy.exec,
    });
    expect(r.ok).toBe(true);
    expect(r.handler).toBe("win32");
    // `start "" <url>` — empty title arg required so Windows doesn't
    // treat the URL as the window title.
    expect(spy.calls[0]?.cmd).toBe("cmd");
    expect(spy.calls[0]?.args).toEqual(["/c", "start", "", "https://example.com"]);
  });

  it("darwin returns ok=false on exec failure", async () => {
    const r = await openInBrowser("https://example.com", {
      platformOverride: "darwin",
      execImpl: makeFailingExec(),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/command not found/);
  });
});
