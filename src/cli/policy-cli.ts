import { existsSync } from "node:fs";
import { Command } from "commander";
import { bus } from "../core/event-bus.js";
import { PolicyEngine } from "../core/policy-engine.js";
import { closeDb, getDb } from "../db/client.js";
import { getForemanPaths } from "../utils/config.js";
import { red } from "./colors.js";
import { launchEditor } from "../tui/launch-editor.js";
import { renderPolicyJson, renderPolicyLine } from "./render.js";

export const policyCommand = new Command("policy").description(
  "Policy commands (show / edit)",
);

policyCommand
  .command("show")
  .description("List all policy rules")
  .option("--json", "output JSON")
  .action((options: { json?: boolean }) => {
    const paths = getForemanPaths();
    if (!existsSync(paths.root)) {
      console.error(
        red("error: ") +
          `Foreman is not initialised. Run 'foreman init' first.`,
      );
      process.exit(1);
    }
    const db = getDb();
    const engine = new PolicyEngine(db, bus);
    if (existsSync(paths.policyPath)) engine.loadFromYaml(paths.policyPath);
    const rows = engine.list();
    if (options.json) {
      process.stdout.write(
        JSON.stringify(rows.map(renderPolicyJson), null, 2) + "\n",
      );
    } else if (rows.length === 0) {
      console.log("(no policy rules — edit ~/.foreman/policy.yaml)");
    } else {
      for (const row of rows) console.log(renderPolicyLine(row));
    }
    closeDb();
  });

policyCommand
  .command("edit")
  .description("Open policy.yaml in $EDITOR and reload after save")
  .action(async () => {
    const paths = getForemanPaths();
    if (!existsSync(paths.root)) {
      console.error(
        red("error: ") +
          `Foreman is not initialised. Run 'foreman init' first.`,
      );
      process.exit(1);
    }
    await launchEditor(paths.policyPath);
    const db = getDb();
    const engine = new PolicyEngine(db, bus);
    const result = engine.loadFromYaml(paths.policyPath);
    console.log(
      `reloaded ${result.rulesAdded} rule${result.rulesAdded === 1 ? "" : "s"} from ${paths.policyPath}`,
    );
    closeDb();
  });
