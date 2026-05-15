import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  freshState,
  loadSetupState,
  markCompleted,
  markUncompleted,
  nextStep,
  resetSetupState,
  saveSetupState,
  STEPS,
} from "../../src/tui/setup-state.js";

describe("setup-state", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "foreman-setup-"));
    statePath = join(tmpDir, "setup-state.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("freshState", () => {
    it("starts with an empty completed list and a timestamp", () => {
      const s = freshState();
      expect(s.version).toBe(1);
      expect(s.completed).toEqual([]);
      expect(s.startedAt).toBeGreaterThan(0);
      expect(s.lastUpdatedAt).toBe(s.startedAt);
    });
  });

  describe("nextStep", () => {
    it("returns 'welcome' on a fresh state", () => {
      expect(nextStep(freshState())).toBe("welcome");
    });

    it("returns the first step not in `completed`", () => {
      const s = { ...freshState(), completed: ["welcome", "providers"] as const };
      expect(nextStep(s as never)).toBe("agents");
    });

    it("returns 'done' once every step is completed", () => {
      const s = { ...freshState(), completed: [...STEPS] };
      expect(nextStep(s)).toBe("done");
    });
  });

  describe("markCompleted", () => {
    it("appends the step in order", () => {
      let s = freshState();
      s = markCompleted(s, "welcome");
      s = markCompleted(s, "providers");
      expect(s.completed).toEqual(["welcome", "providers"]);
    });

    it("is idempotent on the same step", () => {
      let s = freshState();
      s = markCompleted(s, "welcome");
      s = markCompleted(s, "welcome");
      expect(s.completed).toEqual(["welcome"]);
    });

    it("bumps lastUpdatedAt", async () => {
      const s1 = freshState();
      await new Promise((r) => setTimeout(r, 2));
      const s2 = markCompleted(s1, "welcome");
      expect(s2.lastUpdatedAt).toBeGreaterThan(s1.lastUpdatedAt);
    });
  });

  describe("markUncompleted", () => {
    it("removes the named step from completed", () => {
      let s = freshState();
      s = markCompleted(s, "welcome");
      s = markCompleted(s, "providers");
      s = markUncompleted(s, "providers");
      expect(s.completed).toEqual(["welcome"]);
    });

    it("nextStep returns the uncompleted step after markUncompleted", () => {
      let s = freshState();
      s = markCompleted(s, "welcome");
      s = markCompleted(s, "providers");
      s = markUncompleted(s, "providers");
      expect(nextStep(s)).toBe("providers");
    });

    it("also removes every step after the uncompleted one to avoid gaps", () => {
      let s = freshState();
      s = markCompleted(s, "welcome");
      s = markCompleted(s, "providers");
      s = markCompleted(s, "agents");
      s = markUncompleted(s, "providers");
      expect(s.completed).toEqual(["welcome"]);
      expect(nextStep(s)).toBe("providers");
    });

    it("is a no-op when the step is not in completed", () => {
      let s = freshState();
      s = markCompleted(s, "welcome");
      const before = s;
      s = markUncompleted(s, "agents");
      expect(s).toBe(before);
    });

    it("is a no-op when the step name is not a known step", () => {
      let s = freshState();
      s = markCompleted(s, "welcome");
      const before = s;
      s = markUncompleted(s, "not-a-step" as never);
      expect(s).toBe(before);
    });

    it("bumps lastUpdatedAt when state changes", async () => {
      let s = freshState();
      s = markCompleted(s, "welcome");
      const s1 = markCompleted(s, "providers");
      await new Promise((r) => setTimeout(r, 2));
      const s2 = markUncompleted(s1, "providers");
      expect(s2.lastUpdatedAt).toBeGreaterThan(s1.lastUpdatedAt);
    });
  });

  describe("persistence", () => {
    it("loadSetupState returns a fresh state when the file does not exist", () => {
      expect(existsSync(statePath)).toBe(false);
      const s = loadSetupState(statePath);
      expect(s.completed).toEqual([]);
    });

    it("save → load round-trips the completed list", () => {
      let s = freshState();
      s = markCompleted(s, "welcome");
      s = markCompleted(s, "providers");
      saveSetupState(s, statePath);
      const loaded = loadSetupState(statePath);
      expect(loaded.completed).toEqual(["welcome", "providers"]);
      expect(loaded.version).toBe(1);
    });

    it("loadSetupState falls back to fresh on malformed JSON", () => {
      writeFileSync(statePath, "{ broken json");
      const s = loadSetupState(statePath);
      expect(s.completed).toEqual([]);
    });

    it("loadSetupState falls back to fresh on wrong version", () => {
      writeFileSync(
        statePath,
        JSON.stringify({
          version: 99,
          completed: [],
          startedAt: 1,
          lastUpdatedAt: 1,
        }),
      );
      const s = loadSetupState(statePath);
      expect(s.completed).toEqual([]);
      expect(s.version).toBe(1);
    });

    it("loadSetupState falls back to fresh on bad step name", () => {
      writeFileSync(
        statePath,
        JSON.stringify({
          version: 1,
          completed: ["welcome", "not-a-step"],
          startedAt: 1,
          lastUpdatedAt: 1,
        }),
      );
      const s = loadSetupState(statePath);
      expect(s.completed).toEqual([]);
    });

    it("resetSetupState deletes the file (idempotent on missing)", () => {
      saveSetupState(freshState(), statePath);
      expect(existsSync(statePath)).toBe(true);
      resetSetupState(statePath);
      expect(existsSync(statePath)).toBe(false);
      // Calling again is a no-op.
      resetSetupState(statePath);
    });

    it("save writes pretty-printed JSON that another tool can read", () => {
      const s = markCompleted(freshState(), "welcome");
      saveSetupState(s, statePath);
      const text = readFileSync(statePath, "utf-8");
      expect(text).toContain('"welcome"');
      expect(JSON.parse(text).completed).toEqual(["welcome"]);
    });
  });
});
