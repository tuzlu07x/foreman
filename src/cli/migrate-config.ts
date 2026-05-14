import { Command } from "commander";
import {
  executeMigration,
  LegacyConflictError,
  planMigration,
} from "../utils/migrate-config.js";
import { bold, dim, green, orange, red } from "./colors.js";

export const migrateConfigCommand = new Command("migrate-config")
  .description(
    "Move a legacy ~/.foreman/ install into the platform-native config/state/cache dirs",
  )
  .option("--dry-run", "print the planned moves without touching disk")
  .option(
    "--force",
    "overwrite files in the new layout (use only after manual review)",
  )
  .action((options: { dryRun?: boolean; force?: boolean }) => {
    const plan = planMigration();
    switch (plan.status) {
      case "no-legacy":
        console.log(
          dim(
            `nothing to migrate — ${plan.legacyRoot} does not exist (or new layout is the only one in use).`,
          ),
        );
        return;
      case "done":
        console.log(
          dim(
            `nothing left to migrate from ${plan.legacyRoot}. (Run 'foreman doctor' to confirm paths.)`,
          ),
        );
        return;
      case "destination-has-data":
        if (!options.force) {
          console.error(
            red("error: ") +
              `the new layout already has data at ${plan.configDir}/${plan.stateDir}.`,
          );
          console.error(
            `Re-run with --force after backing up if you want to overwrite.`,
          );
          process.exit(1);
        }
        break;
      case "ready":
        break;
    }

    console.log(bold("Foreman config migration"));
    console.log("");
    console.log(`  ${dim("from")}    ${plan.legacyRoot}`);
    console.log(`  ${dim("config")}  ${plan.configDir}`);
    console.log(`  ${dim("state")}   ${plan.stateDir}`);
    console.log(`  ${dim("cache")}   ${plan.cacheDir}`);
    console.log("");

    for (const move of plan.moves) {
      const tag =
        move.destDir === "config"
          ? orange("[config]")
          : move.destDir === "state"
            ? orange("[state] ")
            : orange("[cache] ");
      console.log(`  ${tag} ${move.from}  →  ${move.to}`);
    }

    if (options.dryRun) {
      console.log("");
      console.log(dim("--dry-run set — no files were moved."));
      return;
    }

    console.log("");
    try {
      const summary = executeMigration(plan, { force: options.force });
      console.log(
        `${green("✓")} migrated ${summary.movedCount} file${summary.movedCount === 1 ? "" : "s"}, skipped ${summary.skippedCount}.`,
      );
      console.log(
        dim(
          `${plan.legacyRoot} kept in place (empty dir is harmless). Remove it manually if you'd like: 'rmdir ${plan.legacyRoot}'.`,
        ),
      );
    } catch (err) {
      if (err instanceof LegacyConflictError) {
        console.error(red("error: ") + err.message);
        console.error("Re-run with --force after backing up.");
        process.exit(1);
      }
      throw err;
    }
  });
