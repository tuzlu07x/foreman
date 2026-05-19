import { describe, expect, it } from "vitest";
import { computePickerViewport } from "../../src/tui/setup-wizard.js";

// #448 — Pure viewport math the model + cloud-model pickers use to
// keep the cursor visible when the list is longer than the visible
// window. Tested as a standalone function so the render branches
// stay simple closures over the result.
describe("computePickerViewport (#448)", () => {
  const ten = Array.from({ length: 10 }, (_, i) => `item-${i}`);
  const hundred = Array.from({ length: 100 }, (_, i) => `m-${i}`);

  it("returns all items + zero hidden when list fits the window", () => {
    const vp = computePickerViewport(ten, 0, 12);
    expect(vp.visible).toHaveLength(10);
    expect(vp.start).toBe(0);
    expect(vp.topHidden).toBe(0);
    expect(vp.bottomHidden).toBe(0);
  });

  it("cursor at top → visible starts at 0 + tracks bottomHidden", () => {
    const vp = computePickerViewport(hundred, 0, 12);
    expect(vp.start).toBe(0);
    expect(vp.visible[0]).toBe("m-0");
    expect(vp.topHidden).toBe(0);
    expect(vp.bottomHidden).toBe(88);
  });

  it("cursor in the middle → window centered (half above, half below)", () => {
    const vp = computePickerViewport(hundred, 50, 12);
    // half = floor(12/2) = 6 → start = 50 - 6 = 44
    expect(vp.start).toBe(44);
    expect(vp.visible[0]).toBe("m-44");
    expect(vp.visible[11]).toBe("m-55");
    expect(vp.topHidden).toBe(44);
    expect(vp.bottomHidden).toBe(44);
  });

  it("cursor at the bottom → window clamps to fit the end of list", () => {
    const vp = computePickerViewport(hundred, 99, 12);
    expect(vp.start).toBe(88);
    expect(vp.visible[11]).toBe("m-99");
    expect(vp.topHidden).toBe(88);
    expect(vp.bottomHidden).toBe(0);
  });

  it("cursor past last position (defensive) clamps to last window", () => {
    const vp = computePickerViewport(hundred, 200, 12);
    expect(vp.start).toBe(88);
    expect(vp.bottomHidden).toBe(0);
  });

  it("cursor < 0 (defensive) clamps to start", () => {
    const vp = computePickerViewport(hundred, -5, 12);
    expect(vp.start).toBe(0);
    expect(vp.topHidden).toBe(0);
  });

  it("window of 1 still works (degenerate but valid)", () => {
    const vp = computePickerViewport(hundred, 50, 1);
    expect(vp.visible).toEqual(["m-50"]);
    expect(vp.topHidden).toBe(50);
    expect(vp.bottomHidden).toBe(49);
  });

  it("empty input → empty viewport, zero hidden", () => {
    const vp = computePickerViewport<string>([], 0, 12);
    expect(vp.visible).toEqual([]);
    expect(vp.topHidden).toBe(0);
    expect(vp.bottomHidden).toBe(0);
  });
});
