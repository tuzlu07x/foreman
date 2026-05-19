import { describe, expect, it } from "vitest";
import {
  classifyInstallLog,
  extractMilestone,
} from "../../src/tui/install-log-classify.js";
import { formatElapsed } from "../../src/tui/setup-wizard.js";

// =============================================================================
// #459 — Install-log classifier. Splits the install stream into headline lines
// (Foreman's own ✓/✗/⚠ markers) vs upstream installer chatter (the wall of
// `uv` resolution lines, brew Pouring, etc). The spinner UI shows headlines
// in-line + the single most-recent milestone status; the user is no longer
// drowning in 250-line uv output.
// =============================================================================

describe("classifyInstallLog", () => {
  it("preserves Foreman headline markers in order", () => {
    const result = classifyInstallLog([
      "▸ Hermes",
      "  some uv noise",
      "✓ wrote MCP snippet to ~/.hermes/config.yaml",
      "⚠ broken shim detected — reinstalling",
      "more noise",
    ]);
    expect(result.headlines).toEqual([
      "▸ Hermes",
      "✓ wrote MCP snippet to ~/.hermes/config.yaml",
      "⚠ broken shim detected — reinstalling",
    ]);
  });

  it("collapses upstream noise into a lastMilestone hint", () => {
    const result = classifyInstallLog([
      "▸ Hermes",
      "downloading some sdist",
      "Resolved 217 packages in 4s",
      "linking dependencies (1234/9999)",
      "Installed 217 packages in 1s",
    ]);
    expect(result.lastMilestone).toBe("Installed 217 packages in 1s");
    expect(result.verboseLineCount).toBe(4);
  });

  it("returns null lastMilestone when no upstream line matches a known shape", () => {
    const result = classifyInstallLog([
      "▸ Hermes",
      "  generic blurb that means nothing",
      "  another vague status",
    ]);
    expect(result.lastMilestone).toBeNull();
    expect(result.verboseLineCount).toBe(2);
  });

  it("ignores empty lines completely", () => {
    const result = classifyInstallLog(["▸ Hermes", "", "", "  ", "✓ done"]);
    expect(result.headlines).toEqual(["▸ Hermes", "✓ done"]);
    expect(result.verboseLineCount).toBe(0);
  });

  it("treats indented headline lines as headlines too (Foreman indents nested logs)", () => {
    const result = classifyInstallLog([
      "▸ Hermes",
      "  ✓ already installed at /usr/local/bin/hermes",
      "  ⟳ replaced stale foreman MCP entry",
    ]);
    expect(result.headlines).toHaveLength(3);
  });

  it("ignores npm warn noise (not a real milestone)", () => {
    const result = classifyInstallLog([
      "npm warn deprecated foo@1",
      "added 12 packages in 2s",
    ]);
    expect(result.lastMilestone).toBe("added 12 packages in 2s");
  });
});

describe("extractMilestone", () => {
  it("matches uv-style resolve/install lines", () => {
    expect(extractMilestone("Resolved 217 packages in 4s")).toBe(
      "Resolved 217 packages in 4s",
    );
    expect(extractMilestone("Installed 89 packages")).toBe(
      "Installed 89 packages",
    );
  });

  it("matches brew Pouring + Downloading after stripping the ==> prefix", () => {
    expect(extractMilestone("==> Downloading https://example.com/bottle.tar.gz")).toBe(
      "Downloading https://example.com/bottle.tar.gz",
    );
    expect(extractMilestone("==> Pouring openclaw--1.0.bottle.tar.gz")).toBe(
      "Pouring openclaw--1.0.bottle.tar.gz",
    );
  });

  it("matches Hermes skill + config write headlines", () => {
    expect(extractMilestone("Loaded 89 skills")).toBe("Loaded 89 skills");
    expect(extractMilestone("Wrote ~/.hermes/config.yaml")).toBe(
      "Wrote ~/.hermes/config.yaml",
    );
  });

  it("returns null for noise (git progress, npm warnings)", () => {
    expect(extractMilestone("Receiving objects:  47% (1234/2611)")).toBeNull();
    expect(extractMilestone("npm warn deprecated foo")).toBeNull();
    expect(extractMilestone("random unrecognised line")).toBeNull();
  });
});

describe("formatElapsed (#459)", () => {
  it("renders sub-second values in ms", () => {
    expect(formatElapsed(123)).toBe("123ms");
    expect(formatElapsed(999)).toBe("999ms");
  });

  it("renders sub-minute values in seconds", () => {
    expect(formatElapsed(1000)).toBe("1s");
    expect(formatElapsed(45000)).toBe("45s");
    expect(formatElapsed(59999)).toBe("59s");
  });

  it("renders minute+second values with zero-padded seconds", () => {
    expect(formatElapsed(60_000)).toBe("1m00s");
    expect(formatElapsed(125_000)).toBe("2m05s");
    expect(formatElapsed(192_000)).toBe("3m12s");
  });
});

// #audit-finding-12 — Spinner needs to show which agent is being
// installed RIGHT NOW so a user with a 6-agent batch can see progress.
// We extract it from the latest "▸ <Name>" banner the install loop emits.
describe("classifyInstallLog currentAgentName (#audit-finding-12)", () => {
  it("picks up the agent name from the latest ▸ banner", () => {
    const result = classifyInstallLog([
      "▸ Will install: hermes, codex",
      "▸ Hermes",
      "  ✓ already installed",
      "▸ Codex",
      "  installing…",
    ]);
    expect(result.currentAgentName).toBe("Codex");
  });

  it("returns null before any agent banner fires", () => {
    const result = classifyInstallLog([
      "▸ Will install: hermes, codex",
      "Selected agents: hermes, codex",
    ]);
    expect(result.currentAgentName).toBeNull();
  });

  it("ignores 'Will install:' / 'Will remove:' / 'Selected' banners (not agent names)", () => {
    const result = classifyInstallLog([
      "▸ Will install: hermes",
      "▸ Will remove: codex",
      "▸ Selected agents",
    ]);
    expect(result.currentAgentName).toBeNull();
  });

  it("captures multi-word agent names (e.g. 'Claude Code')", () => {
    const result = classifyInstallLog([
      "▸ Will install: claude-code",
      "▸ Claude Code",
      "  installing…",
    ]);
    expect(result.currentAgentName).toBe("Claude Code");
  });
});
