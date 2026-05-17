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
    const bucketOverrides = engine.getBucketOverrides();
    if (options.json) {
      process.stdout.write(
        JSON.stringify(
          {
            rules: rows.map(renderPolicyJson),
            bucketOverrides,
          },
          null,
          2,
        ) + "\n",
      );
    } else if (rows.length === 0) {
      console.log(`(no policy rules — edit ${paths.policyPath})`);
    } else {
      for (const row of rows) console.log(renderPolicyLine(row));
      if (Object.keys(bucketOverrides).length > 0) {
        console.log("");
        console.log(dim("bucket overrides:"));
        for (const [bucket, effect] of Object.entries(bucketOverrides)) {
          console.log(`  ${bucket.padEnd(9)} ${effect}`);
        }
      }
    }
    closeDb();
  });

policyCommand
  .command("reset")
  .description(
    "Overwrite the active policy.yaml with the smart-default template",
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
      // In non-TTY contexts (CI, piped) the prompt auto-cancels — refuse
      // loudly instead of silently doing nothing (#268, same as #260).
      if (!process.stdin.isTTY) {
        console.error(
          red("error: ") +
            "refusing to reset policy.yaml in a non-interactive context. Pass --yes to confirm.",
        );
        process.exit(1);
      }
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
    // Launching an editor against a non-TTY pipes vim's TUI escape codes
    // into the consumer (CI logs, capturing pipe), corrupts the output, and
    // claims success anyway. Refuse upfront and tell the user where the
    // file is so they can edit it by hand (#268).
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error(
        red("error: ") +
          "'policy edit' requires an interactive terminal — open the file directly:",
      );
      console.error(`       ${paths.policyPath}`);
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
