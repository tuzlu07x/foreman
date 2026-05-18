import { describe, expect, it } from "vitest";
import { buildForemanLlmPickerRows } from "../../src/tui/setup-wizard.js";

describe("buildForemanLlmPickerRows (#370)", () => {
  it("shows all three closed-cloud providers even when none are configured", () => {
    const rows = buildForemanLlmPickerRows(new Set(), false, 0);
    const cloudValues = rows
      .filter((r) =>
        r.value === "anthropic" || r.value === "openai" || r.value === "gemini",
      )
      .map((r) => r.value);
    expect(cloudValues).toEqual(["anthropic", "openai", "gemini"]);
  });

  it("marks Anthropic disabled with a Step 1 hint when not configured", () => {
    const rows = buildForemanLlmPickerRows(new Set(["openai"]), false, 0);
    const anthropic = rows.find((r) => r.value === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.disabled).toBe(true);
    expect(anthropic!.disabledReason).toMatch(/Anthropic/);
    expect(anthropic!.disabledReason).toMatch(/Step 1/i);
  });

  it("marks OpenAI enabled when configured + Anthropic disabled when not", () => {
    const rows = buildForemanLlmPickerRows(new Set(["openai"]), false, 0);
    const openai = rows.find((r) => r.value === "openai");
    const anthropic = rows.find((r) => r.value === "anthropic");
    expect(openai!.disabled).toBe(false);
    expect(anthropic!.disabled).toBe(true);
  });

  it("enables every closed-cloud row when user configured all three", () => {
    const rows = buildForemanLlmPickerRows(
      new Set(["anthropic", "openai", "gemini"]),
      false,
      0,
    );
    for (const value of ["anthropic", "openai", "gemini"] as const) {
      const row = rows.find((r) => r.value === value);
      expect(row!.disabled).toBe(false);
    }
  });

  it("ollama / preset / skip are always enabled regardless of configured state", () => {
    const rowsEmpty = buildForemanLlmPickerRows(new Set(), false, 0);
    const rowsAll = buildForemanLlmPickerRows(
      new Set(["anthropic", "openai", "gemini"]),
      true,
      3,
    );
    for (const rows of [rowsEmpty, rowsAll]) {
      for (const value of ["ollama", "preset", "skip"] as const) {
        const row = rows.find((r) => r.value === value);
        expect(row).toBeDefined();
        expect(row!.disabled).toBe(false);
      }
    }
  });

  it("ollama row sub-text reflects installed + pulled-model count", () => {
    const rowsMissing = buildForemanLlmPickerRows(new Set(), false, 0);
    const rowsInstalled3 = buildForemanLlmPickerRows(new Set(), true, 3);
    const rowsInstalled1 = buildForemanLlmPickerRows(new Set(), true, 1);
    expect(rowsMissing.find((r) => r.value === "ollama")!.sub).toContain(
      "install",
    );
    expect(rowsInstalled3.find((r) => r.value === "ollama")!.sub).toContain(
      "3 models",
    );
    expect(rowsInstalled1.find((r) => r.value === "ollama")!.sub).toContain(
      "1 model already",
    );
  });

  it("row order is stable: closed cloud first, then ollama, preset, skip", () => {
    const rows = buildForemanLlmPickerRows(
      new Set(["anthropic", "openai", "gemini"]),
      true,
      0,
    );
    expect(rows.map((r) => r.value)).toEqual([
      "anthropic",
      "openai",
      "gemini",
      "ollama",
      "preset",
      "skip",
    ]);
  });

  it("disabled rows carry a disabledReason; enabled rows do not", () => {
    const rows = buildForemanLlmPickerRows(new Set(["openai"]), false, 0);
    for (const row of rows) {
      if (row.disabled) {
        expect(row.disabledReason).toBeDefined();
        expect(row.disabledReason!.length).toBeGreaterThan(0);
      } else {
        expect(row.disabledReason).toBeUndefined();
      }
    }
  });
});
