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
// (codex login / claude auth login) can open the user's browser, then run
// the verify command to confirm it took. The wizard does NOT re-mount —
// the user can `foreman doctor` to inspect final state, or just rerun
// `foreman start`.

export interface OauthFlowResult {
  step: WizardOauthRunStep;
  setupExitCode: number | null;
  verifyExitCode: number | null;
  /** True when the setup command succeeded AND (no verify OR verify passed). */
  succeeded: boolean;
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
    const setup = spawnSync(step.command, {
      shell: true,
      stdio: "inherit",
    });
    if (setup.status !== 0) {
      process.stdout.write(
        red(`        ✗ exit ${setup.status ?? "?"} — run manually: ${step.command}\n\n`),
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
        setupExitCode: 0,
        verifyExitCode: null,
        succeeded: true,
      });
      process.stdout.write("\n");
      continue;
    }
    process.stdout.write(dim(`        verifying: ${step.verify}\n`));
    const verify = spawnSync(step.verify, {
      shell: true,
      stdio: "inherit",
    });
    const verifyOk = verify.status === 0;
    process.stdout.write(
      verifyOk
        ? green(`        ✓ verify passed\n\n`)
        : orange(`        ⚠ verify exit ${verify.status ?? "?"} — agent may still need attention\n\n`),
    );
    results.push({
      step,
      setupExitCode: 0,
      verifyExitCode: verify.status,
      succeeded: verifyOk,
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
