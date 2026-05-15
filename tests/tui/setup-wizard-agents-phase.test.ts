import { describe, expect, it } from "vitest";
import {
  applyAgentsPickerSubmit,
  computeAgentDiff,
} from "../../src/tui/setup-wizard.js";

describe("applyAgentsPickerSubmit", () => {
  it("carries the empty selection through to confirm phase", () => {
    const result = applyAgentsPickerSubmit([]);
    expect(result.nextPhase).toBe("confirm");
    expect(result.selected).toEqual([]);
  });

  it("passes the user's selection through unchanged to confirm phase", () => {
    const result = applyAgentsPickerSubmit(["codex"]);
    expect(result.nextPhase).toBe("confirm");
    expect(result.selected).toEqual(["codex"]);
  });

  it("preserves multiple selections in order", () => {
    const result = applyAgentsPickerSubmit([
      "codex",
      "openclaw",
      "claude-code",
    ]);
    expect(result.selected).toEqual(["codex", "openclaw", "claude-code"]);
  });
});

describe("computeAgentDiff", () => {
  it("returns no-op diff when selection matches registered", () => {
    const diff = computeAgentDiff(
      ["hermes", "claude-code"],
      ["hermes", "claude-code"],
    );
    expect(diff.toAdd).toEqual([]);
    expect(diff.toRemove).toEqual([]);
  });

  it("marks newly-selected agents for install (fresh state)", () => {
    const diff = computeAgentDiff(["codex"], []);
    expect(diff.toAdd).toEqual(["codex"]);
    expect(diff.toRemove).toEqual([]);
  });

  it("marks toggled-off defaults for removal", () => {
    // User had hermes + claude-code, toggled both off and added codex.
    const diff = computeAgentDiff(["codex"], ["hermes", "claude-code"]);
    expect(diff.toAdd).toEqual(["codex"]);
    expect(diff.toRemove).toEqual(["hermes", "claude-code"]);
  });

  it("handles partial overlap (keep one, swap one)", () => {
    const diff = computeAgentDiff(
      ["hermes", "codex"],
      ["hermes", "claude-code"],
    );
    expect(diff.toAdd).toEqual(["codex"]);
    expect(diff.toRemove).toEqual(["claude-code"]);
  });

  it("reports empty selection as full removal", () => {
    const diff = computeAgentDiff([], ["hermes"]);
    expect(diff.toAdd).toEqual([]);
    expect(diff.toRemove).toEqual(["hermes"]);
  });

  it("reports both-empty as no-op", () => {
    const diff = computeAgentDiff([], []);
    expect(diff.toAdd).toEqual([]);
    expect(diff.toRemove).toEqual([]);
  });

  it("the user's bug: select only codex on fresh state → toAdd is only codex", () => {
    // Reproduction of #152: user toggled off pre-checked Hermes + Claude Code
    // and selected Codex; the install step must run with toAdd = ["codex"]
    // and not fall back to the defaults.
    const diff = computeAgentDiff(["codex"], []);
    expect(diff.toAdd).toEqual(["codex"]);
    expect(diff.toRemove).toEqual([]);
  });
});
