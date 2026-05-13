import { Command } from "commander";
import { closeDb } from "../db/client.js";
import {
  runDoctor,
  type CheckResult,
  type DoctorReport,
} from "../core/doctor.js";
import { bold, dim, green, orange, red } from "./colors.js";

interface DoctorOptions {
  json?: boolean;
}

export const doctorCommand = new Command("doctor")
  .description("Diagnose the Foreman environment and report any issues")
  .option("--json", "output a structured JSON report")
  .action((options: DoctorOptions) => {
    const report = runDoctor();
    if (options.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      printHumanReport(report);
    }
    closeDb();
    process.exitCode = report.exitCode;
  });

export function printHumanReport(report: DoctorReport): void {
  console.log(bold("Foreman doctor"));
  console.log("");
  for (const check of report.checks) {
    console.log(formatCheckLine(check));
    if (check.remediation && check.status !== "ok") {
      console.log(`     ${dim("→ " + check.remediation)}`);
    }
  }
  console.log("");
  console.log(summaryLine(report));
}

export function formatCheckLine(check: CheckResult): string {
  const icon =
    check.status === "ok"
      ? green("✓")
      : check.status === "warn"
        ? orange("⚠")
        : red("✗");
  return `  ${icon} ${check.name.padEnd(20)} ${dim(check.message)}`;
}

function summaryLine(report: DoctorReport): string {
  const counts = countByStatus(report.checks);
  const parts = [
    counts.ok > 0 ? green(`${counts.ok} ok`) : null,
    counts.warn > 0 ? orange(`${counts.warn} warning`) : null,
    counts.fail > 0 ? red(`${counts.fail} failing`) : null,
  ].filter((p): p is string => p !== null);
  if (counts.fail > 0) return parts.join("  ·  ");
  if (counts.warn > 0)
    return parts.join("  ·  ") + "  " + dim("(exit 1 — warnings)");
  return green("all checks passed") + "  " + dim("(exit 0)");
}

function countByStatus(checks: CheckResult[]): {
  ok: number;
  warn: number;
  fail: number;
} {
  const out = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) out[c.status]++;
  return out;
}
