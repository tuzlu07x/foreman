import { spawnSync } from "node:child_process";
import type { WizardOauthRunStep } from "../tui/setup-wizard.js";
import { bold, dim, green, orange, red } from "./colors.js";

// =============================================================================
// Post-wizard OAuth runner (#468)
// =============================================================================
//
// When the user presses [y] on the wizard's Done screen the wizard exits and
// hands its OAuth/interactive_setup queue to us via the requestOauthRun
// callback. We run each command with inherited stdio so the underlying tool
// (codex login / hermes auth add) can open the user's browser, then run
// the verify command to confirm it took. The wizard does NOT re-mount —
// the user can `foreman doctor` to inspect final state, or just rerun
// `foreman start`.
//
// QA round 7 caught a class of bugs that pure exit-code checking misses:
// agents whose status commands EXIT 0 even when not logged in (hermes
// auth status prints "logged out" but exits 0; the wizard would happily
// report "✓ verify passed" while the user's actually un-authenticated).
// And setup commands whose ENTIRE behavior is "print deprecation notice
// and exit 0" (hermes login was removed but still exits 0). For both,
// we now parse the captured output for known success / failure markers
// and override the exit-code verdict accordingly.

export interface OauthFlowResult {
  step: WizardOauthRunStep;
  setupExitCode: number | null;
  verifyExitCode: number | null;
  /** True when the setup command succeeded AND (no verify OR verify passed). */
  succeeded: boolean;
}

// Phrases that mean "this command exited 0 but did NOT do what we wanted".
// Matched case-insensitively. The setup pass also checks for these — if a
// setup command prints "this command has been removed" and exits 0, we
// must NOT call it a success or the user is left thinking they're logged
// in when nothing happened.
const FAILURE_MARKERS = [
  /\blogged out\b/i,
  /\bnot logged in\b/i,
  /\bno credentials\b/i,
  /\bauth(?:entication)? required\b/i,
  /\bcommand has been removed\b/i,
  /\bcommand not found\b/i,
  /\bdeprecated\b/i,
  /\bunknown subcommand\b/i,
  /\bunrecognized subcommand\b/i,
  /\bunrecognized argument\b/i,
];

// Phrases that ARE positive auth signals. When present we treat verify as
// passed even if exit-code logic is weird.
const SUCCESS_MARKERS = [
  /\blogged in\b/i,
  /\bauthenticated\b/i,
  /\bactive session\b/i,
  /\bsuccessfully logged in\b/i,
];

/**
 * Classify a verify command's output as passed / failed beyond bare exit
 * code. Exit code zero alone is insufficient (`hermes auth status` exits
 * 0 whether the user is logged in or not). Pure helper for tests.
 */
export function classifyVerifyOutput(
  exitCode: number | null,
  output: string,
): { passed: boolean; reason: string | null } {
  const text = output ?? "";
  for (const marker of FAILURE_MARKERS) {
    if (marker.test(text)) {
      const matched = text.match(marker)?.[0] ?? marker.source;
      return {
        passed: false,
        reason: `output indicates failure (matched \`${matched}\`)`,
      };
    }
  }
  if (SUCCESS_MARKERS.some((m) => m.test(text))) {
    return { passed: true, reason: null };
  }
  if (exitCode === 0) return { passed: true, reason: null };
  return {
    passed: false,
    reason: `exit code ${exitCode ?? "?"}, no success markers in output`,
  };
}

/**
 * #audit-finding-runner: Setup commands can ALSO exit 0 while doing
 * nothing useful (Hermes' deprecated `hermes login`). Same content-parse
 * heuristic — fail when output contains "command has been removed" /
 * "deprecated" / "unknown subcommand" even with exit 0.
 */
export function classifySetupOutput(
  exitCode: number | null,
  output: string,
): { ok: boolean; reason: string | null } {
  const text = output ?? "";
  for (const marker of FAILURE_MARKERS) {
    if (marker.test(text)) {
      const matched = text.match(marker)?.[0] ?? marker.source;
      return {
        ok: false,
        reason: `setup output indicates failure (matched \`${matched}\`)`,
      };
    }
  }
  if (exitCode === 0) return { ok: true, reason: null };
  return {
    ok: false,
    reason: `setup exited ${exitCode ?? "?"}`,
  };
}

export function runOauthFlows(steps: WizardOauthRunStep[]): OauthFlowResult[] {
  if (steps.length === 0) return [];
  const results: OauthFlowResult[] = [];
  process.stdout.write("\n");
  process.stdout.write(
    bold(`Running ${steps.length} OAuth setup step${steps.length === 1 ? "" : "s"}\n\n`),
  );
  for (const step of steps) {
    const tag = step.mandatory ? orange("⚠ MUST") : dim("• optional");
    process.stdout.write(
      `${tag}  ${bold(step.agentId)} — ${step.command}\n`,
    );
    if (step.reason) {
      process.stdout.write(dim(`        ${step.reason}\n`));
    }
    process.stdout.write(dim(`        running… (browser may open)\n`));
    // QA round 8: setup MUST use full stdio:inherit. Earlier round 7
    // captured stdout to scan for "command has been removed" markers,
    // but piping stdout buffers output line-by-line — interactive prompts
    // and browser-flow URLs that print without a trailing newline never
    // make it to the user's terminal. Result: hermes auth add hangs at
    // its first prompt with no visible output (`running…` then silence
    // forever). We accept that we'll miss the "command-has-been-removed"
    // signal at SETUP time; verify will catch the consequence (status
    // says "logged out") and report the failure there.
    const setup = spawnSync(step.command, {
      shell: true,
      stdio: "inherit",
    });
    if (setup.status !== 0) {
      process.stdout.write(
        red(
          `        ✗ exit ${setup.status ?? "?"} — run manually: ${step.command}\n\n`,
        ),
      );
      results.push({
        step,
        setupExitCode: setup.status,
        verifyExitCode: null,
        succeeded: false,
      });
      continue;
    }
    process.stdout.write(green(`        ✓ completed\n`));
    if (!step.verify) {
      results.push({
        step,
        setupExitCode: setup.status,
        verifyExitCode: null,
        succeeded: true,
      });
      process.stdout.write("\n");
      continue;
    }
    process.stdout.write(dim(`        verifying: ${step.verify}\n`));
    // Verify can safely capture — it's non-interactive (just prints
    // status). Capture lets us classify "logged in" vs "logged out"
    // even when exit code is 0 for both.
    const verifyCaptured = runWithCaptureAndEcho(step.verify);
    const verifyVerdict = classifyVerifyOutput(
      verifyCaptured.exitCode,
      verifyCaptured.output,
    );
    process.stdout.write(
      verifyVerdict.passed
        ? green(`        ✓ verify passed\n\n`)
        : orange(
            `        ⚠ verify failed (${verifyVerdict.reason ?? "unknown"}) — agent may still need attention\n\n`,
          ),
    );
    results.push({
      step,
      setupExitCode: setup.status,
      verifyExitCode: verifyCaptured.exitCode,
      succeeded: verifyVerdict.passed,
    });
  }
  const succeeded = results.filter((r) => r.succeeded).length;
  process.stdout.write(
    bold(
      `OAuth setup: ${succeeded}/${results.length} succeeded.\n` +
        `Run \`foreman doctor\` to confirm final state.\n\n`,
    ),
  );
  return results;
}

/**
 * Spawn a shell command, capture combined stdout+stderr, AND echo it
 * to the user's terminal as it streams. Lets us still feel "live" for
 * browser OAuth flows while keeping a copy for content-based verdicts.
 *
 * Falls back to inherit-only on environments where capture is awkward
 * (currently always uses pipe; the runner runs after Ink unmounts so
 * the terminal is the real one).
 */
function runWithCaptureAndEcho(command: string): {
  exitCode: number | null;
  output: string;
} {
  const result = spawnSync(command, {
    shell: true,
    stdio: ["inherit", "pipe", "pipe"],
    encoding: "utf-8",
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  // Echo back so the user sees the same content they would have under
  // stdio:inherit (browser URL, "Successfully logged in", etc).
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  return {
    exitCode: result.status,
    output: `${stdout}\n${stderr}`,
  };
}
