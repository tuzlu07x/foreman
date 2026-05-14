import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Command } from "commander";
import { bus } from "../core/event-bus.js";
import { PolicyEngine } from "../core/policy-engine.js";
import { closeDb, getDb } from "../db/client.js";
import { getForemanPaths } from "../utils/config.js";
import { dim, green, red } from "./colors.js";
import { DEFAULT_POLICY_YAML } from "./policy-template.js";
import { launchEditor } from "../tui/launch-editor.js";
import { renderPolicyJson, renderPolicyLine } from "./render.js";

export const policyCommand = new Command("policy").description(
  "Policy commands (show / edit / reset)",
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
    if (existsSync(paths.policyPath)) {
      try {
        engine.loadFromYaml(paths.policyPath);
      } catch (err) {
        printPolicyLoadError(paths.policyPath, err);
        closeDb();
        process.exit(1);
      }
    }
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
  .command("reset")
  .description(
    "Overwrite ~/.foreman/policy.yaml with the smart-default template",
  )
  .option("--yes", "skip the confirmation prompt")
  .action(async (options: { yes?: boolean }) => {
    const paths = getForemanPaths();
    if (!existsSync(paths.root)) {
      console.error(
        red("error: ") +
          `Foreman is not initialised. Run 'foreman init' first.`,
      );
      process.exit(1);
    }
    if (!options.yes) {
      const ok = await promptYesNo(
        `Overwrite ${paths.policyPath} with the default template? [y/N]`,
      );
      if (!ok) {
        console.log("(cancelled)");
        return;
      }
    }
    writeFileSync(paths.policyPath, DEFAULT_POLICY_YAML);
    console.log(
      `${green("✓")} ${paths.policyPath} ${dim("reset to template")}`,
    );
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
    try {
      const result = engine.loadFromYaml(paths.policyPath);
      console.log(
        `reloaded ${result.rulesAdded} rule${result.rulesAdded === 1 ? "" : "s"} from ${paths.policyPath}`,
      );
    } catch (err) {
      printPolicyLoadError(paths.policyPath, err);
      closeDb();
      process.exit(1);
    }
    closeDb();
  });

function printPolicyLoadError(path: string, err: unknown): void {
  // ZodError serialises message as a JSON array (\`[\n  { code: ... }\n]\`);
  // the old split('\\n')[0] reduced it to a useless '['. Detect Zod issues
  // and render the first one's path + message instead. YAML library errors
  // (multi-line with a caret pointer) stay first-line-only.
  let oneLine: string;
  if (
    err !== null &&
    typeof err === "object" &&
    "issues" in err &&
    Array.isArray((err as { issues: unknown }).issues)
  ) {
    const issues = (err as {
      issues: { path: (string | number)[]; message: string }[];
    }).issues;
    const first = issues[0];
    oneLine = first
      ? first.path.length > 0
        ? `${first.path.join(".")}: ${first.message}`
        : first.message
      : String(err);
  } else {
    const detail = err instanceof Error ? err.message : String(err);
    oneLine = detail.split("\n")[0] ?? detail;
  }
  console.error(red("error: ") + `${path} failed to parse: ${oneLine}`);
  console.error(
    dim(`  → Open ${path} and fix the syntax (YAML validators online help).`),
  );
}

async function promptYesNo(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((res) => {
    rl.question(`${prompt} `, (answer) => {
      rl.close();
      res(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
