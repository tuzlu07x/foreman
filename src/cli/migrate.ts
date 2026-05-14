import { existsSync } from "node:fs";
import { Command } from "commander";
import {
  applyMigrations,
  backupDb,
  getMigrationStatus,
} from "../db/migration-status.js";
import { getForemanPaths } from "../utils/config.js";
import { bold, dim, green, orange, red } from "./colors.js";

interface MigrateOptions {
  check?: boolean;
  apply?: boolean;
  /** Skip the foreman.db.bak step (tests / advanced users). */
  noBackup?: boolean;
}

export const migrateCommand = new Command("migrate")
  .description("Inspect or apply pending DB schema migrations")
  .option("--check", "exit non-zero when migrations are pending")
  .option("--apply", "apply pending migrations (creates foreman.db.bak first)")
  .option("--no-backup", "skip the foreman.db.bak backup step")
  .action((options: MigrateOptions) => {
    const paths = getForemanPaths();
    if (!existsSync(paths.dbPath)) {
      console.error(
        red("error: ") +
          `Foreman database not found at ${paths.dbPath}. Run 'foreman init' first.`,
      );
      process.exit(1);
    }

    const status = getMigrationStatus(paths.dbPath, paths.migrationsPath);
    if (options.check) {
      printStatus(status);
      process.exit(status.pendingCount === 0 ? 0 : 1);
    }
    if (options.apply) {
      if (status.pendingCount === 0) {
        console.log(green("✓") + " no migrations pending");
        return;
      }
      printStatus(status);
      if (options.noBackup !== true) {
        const bakPath = backupDb(paths.dbPath);
        if (bakPath) {
          console.log(`${dim("backup")} ${bakPath}`);
        }
      } else {
        console.log(dim("(--no-backup set, skipping foreman.db.bak)"));
      }
      try {
        const result = applyMigrations(paths.dbPath, paths.migrationsPath);
        console.log(
          green("✓") +
            ` applied ${result.appliedNow} migration${result.appliedNow === 1 ? "" : "s"}`,
        );
      } catch (err) {
        console.error(
          red("error: ") +
            `migration failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        console.error(
          "Your backup is at " +
            paths.dbPath +
            ".bak — restore with: " +
            `cp ${paths.dbPath}.bak ${paths.dbPath}`,
        );
        process.exit(2);
      }
      return;
    }

    // No flags: just print status.
    printStatus(status);
  });

function printStatus(status: {
  appliedCount: number;
  pendingCount: number;
  pendingTags: string[];
}): void {
  console.log(bold("Foreman migrations"));
  console.log();
  console.log(`  ${dim("applied")}  ${status.appliedCount}`);
  if (status.pendingCount === 0) {
    console.log(`  ${dim("pending")}  ${green("none — up to date")}`);
    return;
  }
  console.log(`  ${dim("pending")}  ${orange(String(status.pendingCount))}`);
  for (const tag of status.pendingTags) {
    console.log(`    ${orange("▸")} ${tag}`);
  }
}
