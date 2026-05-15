import { describe, expect, it } from "vitest";
import { buildStatusBarLayout } from "../../src/tui/components/status-bar.js";

describe("buildStatusBarLayout", () => {
  describe("wide", () => {
    it("renders a single chatty line and shows the version badge", () => {
      const result = buildStatusBarLayout("wide");
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toContain("[h] help");
      expect(result.rows[0]).toContain("[a] agents");
      expect(result.rows[0]).toContain("[q] quit");
      expect(result.showVersion).toBe(true);
    });
  });

  describe("medium", () => {
    it("renders single-letter hotkeys on one line, keeps the version badge", () => {
      const result = buildStatusBarLayout("medium");
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toBe("[h] [a] [c] [g] [k] [l] [p] [s] [q]");
      expect(result.showVersion).toBe(true);
    });

    it("medium row fits the medium breakpoint comfortably", () => {
      const result = buildStatusBarLayout("medium");
      expect(result.rows[0]!.length).toBeLessThan(80);
    });
  });

  describe("narrow", () => {
    it("splits hotkeys across two lines grouped by purpose", () => {
      const result = buildStatusBarLayout("narrow");
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toContain("nav:");
      expect(result.rows[1]).toContain("system:");
    });

    it("drops the version badge to free space on tiny terminals", () => {
      const result = buildStatusBarLayout("narrow");
      expect(result.showVersion).toBe(false);
    });

    it("each narrow row fits under 60 columns", () => {
      const result = buildStatusBarLayout("narrow");
      for (const row of result.rows) {
        expect(row.length).toBeLessThan(60);
      }
    });
  });

  describe("coverage", () => {
    it("every hotkey appears in every layout (no key is lost on resize)", () => {
      const flatten = (rows: string[]): string => rows.join(" ");
      const wide = flatten(buildStatusBarLayout("wide").rows);
      const medium = flatten(buildStatusBarLayout("medium").rows);
      const narrow = flatten(buildStatusBarLayout("narrow").rows);
      for (const key of ["h", "a", "c", "g", "k", "l", "p", "s", "q"]) {
        expect(wide).toContain(`[${key}]`);
        expect(medium).toContain(`[${key}]`);
        expect(narrow).toContain(`[${key}]`);
      }
    });
  });
});
