import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOauthFlows } from "../../src/cli/run-oauth-flow.js";
import type { WizardOauthRunStep } from "../../src/tui/setup-wizard.js";

// =============================================================================
// #468 — Post-wizard OAuth runner. Spawns OAuth/interactive_setup commands
// with inherited stdio so the browser flow actually opens for the user.
// Tests use shell scripts in a tmpdir to simulate the real-world commands
// (codex login, claude auth login) — no network, no actual browser.
// =============================================================================

describe("runOauthFlows", () => {
  let tmp: string;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "foreman-oauth-flow-"));
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    writeSpy.mockRestore();
  });

  function makeScript(name: string, body: string, mode = 0o755): string {
    const path = join(tmp, name);
    writeFileSync(path, body);
    chmodSync(path, mode);
    return path;
  }

  function step(overrides: Partial<WizardOauthRunStep>): WizardOauthRunStep {
    return {
      agentId: "codex",
      command: "true",
      verify: null,
      mandatory: false,
      reason: null,
      ...overrides,
    };
  }

  it("returns [] for an empty queue without writing any output", () => {
    const result = runOauthFlows([]);
    expect(result).toEqual([]);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("runs a single succeeding command + no verify", () => {
    const cmd = makeScript("login.sh", "#!/bin/sh\nexit 0\n");
    const result = runOauthFlows([step({ command: cmd })]);
    expect(result).toHaveLength(1);
    expect(result[0]?.setupExitCode).toBe(0);
    expect(result[0]?.verifyExitCode).toBeNull();
    expect(result[0]?.succeeded).toBe(true);
  });

  it("runs setup + verify when both succeed", () => {
    const cmd = makeScript("login.sh", "#!/bin/sh\nexit 0\n");
    const verify = makeScript("verify.sh", "#!/bin/sh\nexit 0\n");
    const result = runOauthFlows([
      step({ command: cmd, verify }),
    ]);
    expect(result[0]?.setupExitCode).toBe(0);
    expect(result[0]?.verifyExitCode).toBe(0);
    expect(result[0]?.succeeded).toBe(true);
  });

  it("reports succeeded:false when setup fails — verify is skipped", () => {
    const cmd = makeScript("login.sh", "#!/bin/sh\nexit 1\n");
    const verify = makeScript("verify.sh", "#!/bin/sh\nexit 0\n");
    const result = runOauthFlows([step({ command: cmd, verify })]);
    expect(result[0]?.setupExitCode).toBe(1);
    expect(result[0]?.verifyExitCode).toBeNull();
    expect(result[0]?.succeeded).toBe(false);
  });

  it("reports succeeded:false when setup succeeds but verify fails", () => {
    const cmd = makeScript("login.sh", "#!/bin/sh\nexit 0\n");
    const verify = makeScript("verify.sh", "#!/bin/sh\nexit 2\n");
    const result = runOauthFlows([step({ command: cmd, verify })]);
    expect(result[0]?.setupExitCode).toBe(0);
    expect(result[0]?.verifyExitCode).toBe(2);
    expect(result[0]?.succeeded).toBe(false);
  });

  it("runs every queued step even when one fails", () => {
    const ok = makeScript("ok.sh", "#!/bin/sh\nexit 0\n");
    const bad = makeScript("bad.sh", "#!/bin/sh\nexit 1\n");
    const result = runOauthFlows([
      step({ agentId: "codex", command: ok }),
      step({ agentId: "hermes", command: bad, mandatory: true }),
      step({ agentId: "claude-code", command: ok }),
    ]);
    expect(result).toHaveLength(3);
    expect(result[0]?.succeeded).toBe(true);
    expect(result[1]?.succeeded).toBe(false);
    expect(result[2]?.succeeded).toBe(true);
  });

  it("surfaces the mandatory tag + reason text in the log output", () => {
    const cmd = makeScript("login.sh", "#!/bin/sh\nexit 0\n");
    runOauthFlows([
      step({
        command: cmd,
        mandatory: true,
        reason: "hermes routes openai through codex's OAuth",
      }),
    ]);
    const allWrites = writeSpy.mock.calls
      .map((c) => String(c[0]))
      .join("");
    expect(allWrites).toContain("MUST");
    expect(allWrites).toContain(
      "hermes routes openai through codex's OAuth",
    );
  });

  it("prints a final summary line counting successes", () => {
    const ok = makeScript("ok.sh", "#!/bin/sh\nexit 0\n");
    const bad = makeScript("bad.sh", "#!/bin/sh\nexit 1\n");
    runOauthFlows([step({ command: ok }), step({ command: bad })]);
    const all = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(all).toMatch(/OAuth setup: 1\/2 succeeded/);
    expect(all).toMatch(/foreman doctor/);
  });
});
