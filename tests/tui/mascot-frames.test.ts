import { describe, expect, it } from "vitest";
import {
  MASCOT_COLUMNS,
  MASCOT_HEIGHT,
  MASCOT_PALETTE,
  MASCOT_WIDTH,
  mascotRows,
  mascotVisible,
  pixelRuns,
} from "../../src/tui/components/mascot-frames.js";

// The pixel mascot: every row is the same number of pixels, two columns
// each, so the terminal width never depends on the font (no ambiguous-width
// glyphs).
describe("pixel mascot", () => {
  it("is a 10×7 grid, 20 columns wide", () => {
    const rows = mascotRows();
    expect(rows).toHaveLength(MASCOT_HEIGHT);
    expect(MASCOT_HEIGHT).toBe(7);
    expect(MASCOT_WIDTH).toBe(10);
    expect(MASCOT_COLUMNS).toBe(20);
    for (const row of rows) expect(row).toHaveLength(MASCOT_WIDTH);
  });

  it("wears a hard hat and blinks with its eyes only", () => {
    const open = mascotRows(false);
    const blink = mascotRows(true);
    expect(open[0]!.filter((p) => p === "hat")).toHaveLength(4);
    expect(open[2]!.every((p) => p === "brim")).toBe(true);
    const changed = open.map((row, i) => row.some((p, j) => p !== blink[i]![j])).filter(Boolean);
    expect(changed).toHaveLength(1);
    expect(open[4]!.filter((p) => p === "eye")).toHaveLength(2);
    expect(blink[4]!.includes("eye")).toBe(false);
  });

  it("uses only its palette", () => {
    for (const row of mascotRows()) for (const p of row) if (p !== null) expect(MASCOT_PALETTE[p]).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("groups a row into runs that add up to its width", () => {
    const runs = pixelRuns(mascotRows()[4]!);
    expect(runs.reduce((n, r) => n + r.width, 0)).toBe(MASCOT_WIDTH);
    expect(runs[0]).toEqual({ pixel: null, width: 1 });
    expect(runs[1]).toEqual({ pixel: "fur", width: 1 });
    expect(runs[2]).toEqual({ pixel: "eye", width: 1 });
  });

  it("is drawn only where colour shows", () => {
    expect(mascotVisible({}, { isTTY: true })).toBe(true);
    expect(mascotVisible({ NO_COLOR: "1" }, { isTTY: true })).toBe(false);
    expect(mascotVisible({ FORCE_COLOR: "0" }, { isTTY: true })).toBe(false);
    expect(mascotVisible({}, { isTTY: false })).toBe(false);
    expect(mascotVisible({ FORCE_COLOR: "1" }, { isTTY: false })).toBe(true);
  });
});
