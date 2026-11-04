import { describe, expect, it, vi } from "vitest";
import { type QuickstartIo, type QuickstartSteps, runQuickstart } from "../../src/cli/quickstart.js";

const CHAT = { chatId: "42", name: "Fatih" };

function harness(over: Partial<QuickstartSteps> = {}, answers: string[] = ["", "y"], tokens: string[] = ["good"]) {
  const lines: string[] = [];
  const io: QuickstartIo = {
    say: (line) => lines.push(line),
    ask: async () => answers.shift() ?? "",
    askSecret: async () => tokens.shift() ?? "good",
    wait: async () => undefined,
  };
  const steps: QuickstartSteps = {
    gatewayRunning: () => null,
    customHome: () => null,
    guardChanges: () => ["/home/me/.claude/settings.json: adds Foreman's hook"],
    connectClaude: vi.fn(async () => undefined),
    guardClaude: vi.fn(async () => undefined),
    telegramReady: () => false,
    checkBot: vi.fn(async (token: string) =>
      token === "good"
        ? ({ status: "ok", value: { username: "my_bot" } } as const)
        : ({ status: "rejected", detail: null } as const),
    ),
    findChat: vi.fn(async () => ({ status: "ok", value: CHAT }) as const),
    saveTelegram: vi.fn(async () => ({ ok: true }) as const),
    firstApproval: vi.fn(async () => "denied" as const),
    ...over,
  };
  return { io, steps, lines, text: () => lines.join("\n") };
}

describe("foreman quickstart", () => {
  it("goes from Claude Code to Telegram to a first approval card", async () => {
    const h = harness({}, ["y", "y"]);
    expect(await runQuickstart(h.io, h.steps)).toBe(0);
    expect(h.steps.guardClaude).toHaveBeenCalledWith(true);
    expect(h.text()).toContain("settings.json: adds Foreman's hook");
    expect(h.text()).toContain("foreman agent remove claude-code");
    expect(h.steps.saveTelegram).toHaveBeenCalledWith("good", "42");
    expect(h.steps.firstApproval).toHaveBeenCalledOnce();
    expect(h.text()).toContain("Blocked");
    expect(h.text()).toContain("foreman start");
  });

  // The real test: a stray Enter put Foreman in the real Claude Code settings.
  it("leaves Claude Code's settings alone on a bare Enter, and goes on", async () => {
    const h = harness({}, ["", "y"]);
    expect(await runQuickstart(h.io, h.steps)).toBe(0);
    expect(h.steps.guardClaude).toHaveBeenCalledWith(false);
    expect(h.text()).toContain("foreman agent hook install claude-code");
  });

  // ...and that hook pointed at another home than the card went through.
  it("never asks to touch Claude Code's settings from a separate home", async () => {
    const asked: string[] = [];
    const h = harness({ customHome: () => "/tmp/test-home" });
    const io = { ...h.io, ask: async (q: string) => (asked.push(q), "y") };
    expect(await runQuickstart(io, h.steps)).toBe(0);
    expect(h.steps.guardClaude).toHaveBeenCalledWith(false);
    expect(asked.some((q) => q.includes("Guard Claude Code"))).toBe(false);
    expect(h.text()).toContain("/tmp/test-home");
  });

  it("won't run beside a running Foreman: it couldn't see the new channel", async () => {
    const h = harness({ gatewayRunning: () => "`foreman start` (pid 7)" });
    expect(await runQuickstart(h.io, h.steps)).toBe(1);
    expect(h.steps.connectClaude).not.toHaveBeenCalled();
    expect(h.text()).toContain("already running");
  });

  it("stops with Claude Code's own reason when it can't connect", async () => {
    const h = harness({ connectClaude: async () => { throw new Error("Claude Code isn't installed"); } });
    expect(await runQuickstart(h.io, h.steps)).toBe(1);
    expect(h.text()).toContain("isn't installed");
    expect(h.steps.firstApproval).not.toHaveBeenCalled();
  });

  it("gives a mistyped token two more chances", async () => {
    const h = harness({}, undefined, ["bad", "bad", "good"]);
    expect(await runQuickstart(h.io, h.steps)).toBe(0);
    expect(h.steps.checkBot).toHaveBeenCalledTimes(3);
  });

  it("gives up after three bad tokens, without saving one", async () => {
    const h = harness({}, undefined, ["a", "b", "c"]);
    expect(await runQuickstart(h.io, h.steps)).toBe(1);
    expect(h.steps.saveTelegram).not.toHaveBeenCalled();
  });

  it("uses a chat only once you confirm it's yours", async () => {
    const h = harness({}, ["", "n", "", "y"]);
    const first = { status: "ok", value: { chatId: "666", name: "Stranger" } } as const;
    const second = { status: "ok", value: CHAT } as const;
    h.steps.findChat = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    expect(await runQuickstart(h.io, h.steps)).toBe(0);
    expect(h.steps.saveTelegram).toHaveBeenCalledTimes(1);
    expect(h.steps.saveTelegram).toHaveBeenCalledWith("good", "42");
  });

  it("waits for your message, then gives up with what to do", async () => {
    const h = harness({ findChat: vi.fn(async () => ({ status: "ok", value: null }) as const) });
    expect(await runQuickstart(h.io, h.steps)).toBe(1);
    expect(h.text()).toContain("No message arrived");
  });

  it("skips Telegram when it's already connected", async () => {
    const h = harness({ telegramReady: () => true });
    expect(await runQuickstart(h.io, h.steps)).toBe(0);
    expect(h.steps.checkBot).not.toHaveBeenCalled();
  });

  it("reports a failed test message and stops", async () => {
    const h = harness({ saveTelegram: async () => ({ ok: false, reason: "You blocked the bot." }) });
    expect(await runQuickstart(h.io, h.steps)).toBe(1);
    expect(h.text()).toContain("You blocked the bot.");
  });

  it("explains an Allow, and fails when the card never came back", async () => {
    const allowed = harness({ firstApproval: async () => "allowed" });
    expect(await runQuickstart(allowed.io, allowed.steps)).toBe(0);
    expect(allowed.text()).toContain("Allowed");
    const lost = harness({ firstApproval: async () => "failed" });
    expect(await runQuickstart(lost.io, lost.steps)).toBe(1);
    expect(lost.text()).toContain("foreman doctor");
  });
});
