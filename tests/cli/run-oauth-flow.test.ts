import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifySetupOutput,
  classifyVerifyOutput,
  isHeadlessEnvironment,
  rewriteForHeadless,
  runOauthFlows,
} from "../../src/cli/run-oauth-flow.js";
import type { WizardOauthRunStep } from "../../src/tui/setup-wizard.js";

// =============================================================================
// #468 — Post-wizard OAuth runner. Spawns OAuth/interactive_setup commands
// with inherited stdio so the browser flow actually opens for the user.
// Tests use shell scripts in a tmpdir to simulate the real-world commands
// (codex login, claude auth login) — no network, no actual browser.
// =============================================================================

describe("isHeadlessEnvironment", () => {
  it("treats Linux with no display server as headless", () => {
    expect(isHeadlessEnvironment({}, "linux")).toBe(true);
  });

  it("is not headless on Linux with a display", () => {
    expect(isHeadlessEnvironment({ DISPLAY: ":0" }, "linux")).toBe(false);
    expect(isHeadlessEnvironment({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(
      false,
    );
  });

  it("is not headless on macOS / Windows by default", () => {
    expect(isHeadlessEnvironment({}, "darwin")).toBe(false);
    expect(isHeadlessEnvironment({}, "win32")).toBe(false);
  });

  it("treats an SSH session as headless on any platform", () => {
    expect(isHeadlessEnvironment({ SSH_CONNECTION: "1.2.3.4 22" }, "darwin")).toBe(
      true,
    );
    expect(isHeadlessEnvironment({ SSH_TTY: "/dev/pts/0" }, "darwin")).toBe(true);
  });

  it("honors the FOREMAN_HEADLESS override both ways", () => {
    expect(isHeadlessEnvironment({ FOREMAN_HEADLESS: "1" }, "darwin")).toBe(true);
    // explicit 0 wins even on Linux with no display
    expect(isHeadlessEnvironment({ FOREMAN_HEADLESS: "0" }, "linux")).toBe(false);
  });
});

describe("rewriteForHeadless", () => {
  it("adds --device-auth to `codex login`", () => {
    expect(rewriteForHeadless("codex login")).toBe("codex login --device-auth");
  });

  it("is idempotent — does not double-add --device-auth", () => {
    expect(rewriteForHeadless("codex login --device-auth")).toBe(
      "codex login --device-auth",
    );
  });

  it("does not touch `codex login status` (verify command)", () => {
    expect(rewriteForHeadless("codex login status")).toBe("codex login status");
  });

  it("leaves unknown commands unchanged", () => {
    expect(rewriteForHeadless("hermes auth add openai-codex --type oauth")).toBe(
      "hermes auth add openai-codex --type oauth",
    );
  });
});

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

// QA round 7: exit-code-only verification missed two failure modes both
// caught against real Hermes binaries — status commands that exit 0 while
// printing "logged out", and deprecated setup commands that exit 0 while
// printing "command has been removed". Content-parsing safeguards each.
describe("classifyVerifyOutput (#oauth-runner-smart-verify)", () => {
  it("passes when output mentions 'Logged in' even with exit 0", () => {
    const v = classifyVerifyOutput(0, "Logged in using ChatGPT\n");
    expect(v.passed).toBe(true);
  });

  it("fails when output says 'logged out' despite exit 0", () => {
    const v = classifyVerifyOutput(
      0,
      "openai-codex: logged out (No Codex credentials stored. Run `hermes auth` to authenticate.)\n",
    );
    expect(v.passed).toBe(false);
    expect(v.reason?.toLowerCase()).toContain("logged out");
  });

  it("fails when output mentions 'No credentials' despite exit 0", () => {
    const v = classifyVerifyOutput(0, "No credentials configured");
    expect(v.passed).toBe(false);
  });

  it("trusts exit 0 + empty output as passing (no markers either way)", () => {
    const v = classifyVerifyOutput(0, "");
    expect(v.passed).toBe(true);
  });

  it("fails on non-zero exit with no success markers", () => {
    const v = classifyVerifyOutput(2, "some bespoke error");
    expect(v.passed).toBe(false);
    expect(v.reason).toContain("exit code 2");
  });

  it("rescues exit-non-zero when output explicitly says authenticated", () => {
    const v = classifyVerifyOutput(1, "✓ authenticated (session active)");
    expect(v.passed).toBe(true);
  });
});

describe("classifySetupOutput (#oauth-runner-smart-verify)", () => {
  it("flags the deprecated 'command has been removed' case as failure", () => {
    const s = classifySetupOutput(
      0,
      "The 'hermes login' command has been removed.\nUse 'hermes auth' to manage credentials, ...",
    );
    expect(s.ok).toBe(false);
    expect(s.reason?.toLowerCase()).toContain("removed");
  });

  it("flags 'command not found' as failure", () => {
    const s = classifySetupOutput(0, "zsh: command not found: hermes");
    expect(s.ok).toBe(false);
  });

  it("flags 'unrecognized subcommand' as failure", () => {
    const s = classifySetupOutput(
      0,
      "error: unrecognized subcommand 'status'\n  tip: a similar subcommand exists: 'a'",
    );
    expect(s.ok).toBe(false);
  });

  it("trusts exit 0 + benign output", () => {
    const s = classifySetupOutput(0, "Successfully logged in");
    expect(s.ok).toBe(true);
  });

  it("fails on non-zero exit", () => {
    const s = classifySetupOutput(2, "something went wrong");
    expect(s.ok).toBe(false);
    expect(s.reason).toContain("exited 2");
  });
});
