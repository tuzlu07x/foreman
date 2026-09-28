import { existsSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { bus } from "../core/event-bus.js";
import {
  NotRememberedRuleError,
  PolicyEngine,
  PolicyRuleNotFoundError,
  type RuleConditions,
} from "../core/policy-engine.js";
import { terminalSafe } from "../core/terminal-text.js";
import { closeDb, getDb } from "../db/client.js";
import { getForemanPaths } from "../utils/config.js";
import { dim, green, orange, red } from "./colors.js";
import { DEFAULT_POLICY_YAML } from "./policy-template.js";
import { launchEditor } from "../tui/launch-editor.js";
import { renderPolicyJson, renderPolicyLine } from "./render.js";
import { requireConfirm, requireTty } from "./require-confirm.js";

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
    const ok = await requireConfirm({
      yes: options.yes,
      question: `Overwrite ${paths.policyPath} with the default template?`,
      noun: "reset policy.yaml",
    });
    if (!ok) {
      console.log("(cancelled)");
      return;
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
    requireTty({ command: "policy edit", fallbackPath: paths.policyPath });
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

// #656 — the rules your answers created ("always allow", "deny always",
// block buttons) live outside policy.yaml. List them and take one back.
const rememberedCommand = policyCommand
  .command("remembered")
  .description("Rules made from your approval answers (always allow / deny always): list, remove");

rememberedCommand
  .command("list", { isDefault: true })
  .description("List remembered rules, newest first")
  .option("--json", "output JSON")
  .action((options: { json?: boolean }) => {
    const engine = openEngine();
    const rows = engine.listRemembered();
    if (options.json) {
      process.stdout.write(`${JSON.stringify(rows.map(renderPolicyJson), null, 2)}\n`);
    } else if (rows.length === 0) {
      console.log("(no remembered rules)");
    } else {
      for (const row of rows) {
        const effect = row.effect === "allow" ? green("ALLOW") : row.effect === "deny" ? red("DENY") : orange("ASK");
        console.log(
          `${dim(`#${row.id}`)}  ${orange(terminalSafe(row.sourceAgent))} ${dim("→")} ${terminalSafe(row.target)}  ${effect}` +
            `${row.enabled === 1 ? "" : dim(" DISABLED")}  ${dim(terminalSafe(describeScope(row.conditions)))}  ${dim(new Date(row.createdAt).toISOString())}`,
        );
      }
      console.log(dim("\nRemove one: foreman policy remembered remove <id>"));
    }
    closeDb();
  });

rememberedCommand
  .command("remove <id>")
  .description("Remove a remembered rule")
  .option("--yes", "skip the confirmation prompt")
  .action(async (idArg: string, options: { yes?: boolean }) => {
    const id = Number(idArg.replace(/^#/, ""));
    if (!Number.isInteger(id) || id <= 0) {
      console.error(red("error: ") + "the id is the number `foreman policy remembered list` shows (e.g. 12)");
      process.exit(1);
    }
    const engine = openEngine();
    const row = engine.listRemembered().find((r) => r.id === id);
    if (!row) {
      const exists = engine.list().some((r) => r.id === id);
      console.error(
        red("error: ") +
          (exists
            ? `rule #${id} comes from policy.yaml; edit ${getForemanPaths().policyPath} to change it`
            : `no remembered rule #${id} (see foreman policy remembered list)`),
      );
      closeDb();
      process.exit(1);
    }
    const ok = await requireConfirm({
      yes: options.yes,
      question: `Remove rule #${id} (${terminalSafe(row.sourceAgent)} → ${terminalSafe(row.target)} ${row.effect.toUpperCase()}, ${terminalSafe(describeScope(row.conditions))})?`,
      noun: `remove rule #${id}`,
    });
    if (!ok) {
      console.log("(cancelled)");
      closeDb();
      return;
    }
    try {
      // A block rule is removed from policy.yaml too (#656).
      engine.removeRemembered(id, { policyYamlPath: getForemanPaths().policyPath });
    } catch (err) {
      if (err instanceof PolicyRuleNotFoundError || err instanceof NotRememberedRuleError) {
        console.error(red("error: ") + err.message);
        closeDb();
        process.exit(1);
      }
      throw err;
    }
    console.log(`${green("✓")} removed rule #${id}`);
    closeDb();
  });

function openEngine(): PolicyEngine {
  const paths = getForemanPaths();
  if (!existsSync(paths.root)) {
    console.error(red("error: ") + `Foreman is not initialised. Run 'foreman init' first.`);
    process.exit(1);
  }
  return new PolicyEngine(getDb(), bus);
}

/** What a rule's conditions limit it to, in one line. */
export function describeScope(raw: string | null): string {
  if (!raw) return "every call to the tool";
  let cond: RuleConditions;
  try {
    cond = JSON.parse(raw) as RuleConditions;
  } catch {
    return "(unreadable conditions)";
  }
  const parts: string[] = [];
  if (cond.pathMatch?.length) parts.push(`path matches ${cond.pathMatch.join(" or ")}`);
  if (cond.commandMatch?.length) parts.push(`command contains ${cond.commandMatch.map((c) => JSON.stringify(c)).join(" or ")}`);
  if (cond.toolPattern) parts.push(`tool matches ${cond.toolPattern}`);
  if (cond.argContains) parts.push(`an argument contains ${JSON.stringify(cond.argContains)}`);
  if (cond.pathNotMatch) parts.push(`path doesn't match ${cond.pathNotMatch}`);
  return parts.length > 0 ? `only when ${parts.join(" and ")}` : "every call to the tool";
}

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

