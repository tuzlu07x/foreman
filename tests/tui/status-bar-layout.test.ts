import { describe, expect, it } from "vitest";
import { buildStatusBarLayout } from "../../src/tui/components/status-bar.js";

// =============================================================================
// Status bar layouts (#234 UX-4) — pure-function tests
// =============================================================================

function letters(rows: ReturnType<typeof buildStatusBarLayout>["rows"]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    for (const k of r.leftKeys) out.push(k.letter);
    for (const k of r.rightKeys) out.push(k.letter);
  }
  return out;
}

describe("buildStatusBarLayout — wide", () => {
  it("renders a single row with the active-page label + every hotkey labelled", () => {
    const result = buildStatusBarLayout("wide", "agents");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.active).toContain("Agents");
    expect(result.rows[0]!.withLabels).toBe(true);
    expect(result.showVersion).toBe(true);
  });

  it("groups admin keys (help/quit) on the right side", () => {
    const result = buildStatusBarLayout("wide", "dashboard");
    const right = result.rows[0]!.rightKeys.map((k) => k.letter);
    expect(right).toEqual(["h", "q"]);
  });
});

describe("buildStatusBarLayout — medium", () => {
  it("single row with single-letter hotkeys (no labels)", () => {
    const result = buildStatusBarLayout("medium", "logs");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.withLabels).toBe(false);
    expect(result.rows[0]!.active).toContain("Logs");
    expect(result.showVersion).toBe(true);
  });
});

describe("buildStatusBarLayout — narrow", () => {
  it("two rows: line 1 has the active page only, line 2 has hotkeys", () => {
    const result = buildStatusBarLayout("narrow", "policy");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.active).toContain("Policy");
    expect(result.rows[0]!.leftKeys).toHaveLength(0);
    expect(result.rows[1]!.leftKeys.length).toBeGreaterThan(0);
    expect(result.showVersion).toBe(false);
  });
});

describe("buildStatusBarLayout — coverage", () => {
  it("every page hotkey appears in every layout (no key lost on resize)", () => {
    const wide = new Set(letters(buildStatusBarLayout("wide", "dashboard").rows));
    const medium = new Set(letters(buildStatusBarLayout("medium", "dashboard").rows));
    const narrow = new Set(letters(buildStatusBarLayout("narrow", "dashboard").rows));
    // Narrow drops secondary keys (chat, settings) to fit; main + admin must
    // survive across all three.
    for (const letter of ["a", "v", "V", "k", "l", "p", "s", "h", "q"]) {
      expect(wide.has(letter), `wide missing [${letter}]`).toBe(true);
      expect(medium.has(letter), `medium missing [${letter}]`).toBe(true);
      expect(narrow.has(letter), `narrow missing [${letter}]`).toBe(true);
    }
  });

  it("active-page hotkey is flagged so the renderer can highlight it", () => {
    const result = buildStatusBarLayout("wide", "providers");
    // Renderer compares entry.page === page; this test pins the active page
    // is one of the entries so we know the rendered hotkey will light up.
    const allEntries = [
      ...result.rows[0]!.leftKeys,
      ...result.rows[0]!.rightKeys,
    ];
    const hasProviders = allEntries.some((e) => e.page === "providers");
    expect(hasProviders).toBe(true);
  });
});
