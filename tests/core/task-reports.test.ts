import { describe, expect, it } from "vitest";
import type { ControlCommand } from "../../src/db/schema.js";
import { TaskReports } from "../../src/core/task-reports.js";

const row = (id: number, agent: string, over: Partial<ControlCommand> = {}): ControlCommand => ({
  id,
  command: "write",
  args: JSON.stringify([agent, "do it"]),
  sourceAgent: "telegram",
  sourceUser: "telegram:1",
  status: "applied",
  error: null,
  afterIds: null,
  createdAt: 1,
  appliedAt: 2,
  ...over,
});
const ok = (stdout: string) => ({ spawn: { kind: "ok", stdout, stderr: "", exitCode: 0, durationMs: 1 } as never, handedOn: false });

describe("TaskReports", () => {
  const setup = () => {
    const told: Array<[string, string, string]> = [];
    return { told, reports: new TaskReports((c, t, b) => told.push([c, t, b])) };
  };

  it("tells the chat app a task came from when it ends", () => {
    const { told, reports } = setup();
    reports.note(1, ok("Built it.\nAll tests pass."));
    reports.settled(row(1, "backend"));
    expect(told).toEqual([["telegram", "backend finished", "Built it. All tests pass."]]);
  });

  it("stays quiet about what agents hand each other and the TUI's own tasks", () => {
    const { told, reports } = setup();
    reports.settled(row(1, "dev", { sourceAgent: "backend" }));
    reports.settled(row(2, "dev", { sourceAgent: "tui" }));
    reports.settled(row(3, "dev", { command: "stop" }));
    expect(told).toEqual([]);
  });

  it("reports a plan once, when every step has ended, in plan order", () => {
    const { told, reports } = setup();
    const add = reports.plan("slack");
    add(1);
    add(2);
    add(3);
    reports.note(2, ok("Page done."));
    reports.settled(row(2, "frontend", { sourceAgent: "slack" }));
    reports.note(1, ok("API done."));
    reports.settled(row(1, "backend", { sourceAgent: "slack" }));
    expect(told).toEqual([]);
    reports.settled(row(3, "tester", { sourceAgent: "slack", status: "rejected", error: "Not started: backend failed" }));
    expect(told).toEqual([
      [
        "slack",
        "Plan finished with problems",
        "✓ backend: API done.\n\n✓ frontend: Page done.\n\n✗ tester: Not started: backend failed",
      ],
    ]);
  });

  it("says a run left work with others, and why one failed", () => {
    const { told, reports } = setup();
    reports.note(1, { ...ok("Asked the designer."), handedOn: true });
    reports.settled(row(1, "lead"));
    reports.note(2, { spawn: { kind: "timeout", timeoutMs: 600_000, stdout: "", stderr: "" } as never, handedOn: false });
    reports.settled(row(2, "dev", { status: "failed", error: "agent timed out" }));
    expect(told).toEqual([
      ["telegram", "lead finished", "handed it on. Asked the designer."],
      ["telegram", "dev didn't finish", "stopped after 600s"],
    ]);
  });

  it("keeps secrets out of what it sends", () => {
    const { told, reports } = setup();
    const token = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
    reports.note(1, ok(`Used ${token} to push.`));
    reports.settled(row(1, "dev"));
    expect(told[0]![2]).not.toContain(token);
  });
});
