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
  .addHelpText(
    "after",
    `
Exit codes:
  0  all checks passed
  1  one or more warnings (e.g. optional dependency missing, no agents yet)
  2  one or more failures (e.g. corrupt database, missing identity)

Pipe-friendly: redirect stderr to suppress the human report and rely on the
exit code, or use --json for a parseable summary.
`,
  )
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
  const { ok, warn, fail } = report.summary;
  const parts = [
    ok > 0 ? green(`${ok} ok`) : null,
    warn > 0 ? orange(`${warn} warning`) : null,
    fail > 0 ? red(`${fail} failing`) : null,
  ].filter((p): p is string => p !== null);
  if (fail > 0) {
    return parts.join("  ·  ") + "  " + dim("(exit 2 — action required)");
  }
  if (warn > 0) {
    return parts.join("  ·  ") + "  " + dim("(exit 1 — warnings only)");
  }
  return green("all checks passed") + "  " + dim("(exit 0)");
}
