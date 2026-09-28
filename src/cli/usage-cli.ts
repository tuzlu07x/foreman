import { existsSync } from "node:fs";
import { Command } from "commander";
import { closeDb, getDb } from "../db/client.js";
import { foremanSpend, formatCost, formatTokens, formatUsd, parsePeriod, spendBy } from "../core/usage/report.js";
import { agentUsageKey } from "../core/usage/agent-key.js";
import { codexTelemetrySnippet, loadOrCreateUsageKey, otlpPort, telemetryEnv } from "../core/usage/telemetry-env.js";
import { getForemanPaths } from "../utils/config.js";
import { bold, dim, green, orange, red } from "./colors.js";

// =============================================================================
// foreman usage — agent spend at a glance, and how to turn tracking on (#629)
// =============================================================================
//
//   foreman usage                 today, by department
//   foreman usage month --by agent
//   foreman usage env claude-code print the lines that make an agent you
//                                 start yourself report its usage

export const usageCommand = new Command("usage").description(
  "Agent token spend by department, agent or model (see also: foreman org report)",
);

usageCommand
  .argument("[period]", "today · yesterday · week · month · 7d", "today")
  .option("--by <group>", "department | agent | model", "department")
  .option("--json", "output JSON")
  .action((period: string, opts: { by: string; json?: boolean }) => {
    requireInitialised();
    const p = parsePeriod(period);
    if (!p) fail(`unknown period '${period}' — use today, yesterday, week, month or e.g. 7d`);
    if (!["department", "agent", "model"].includes(opts.by)) fail("--by is department, agent or model");
    const db = getDb();
    try {
      const rows = spendBy(db, opts.by as "department" | "agent" | "model", p);
      const foreman = foremanSpend(db, p);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ period: p, rows, foreman }, null, 2)}\n`);
        return;
      }
      const total = rows.reduce((s, r) => s + r.costUsd, 0) + (foreman?.costUsd ?? 0);
      const estimated = rows.some((r) => r.estimated);
      console.log(`${orange(bold("Agent spend"))} · ${p.label} · ${bold(formatUsd(total, estimated))}`);
      if (rows.length === 0 && !foreman) {
        console.log(dim("  Nothing recorded yet. Agents Foreman starts report automatically;"));
        console.log(dim("  for agents you start yourself: foreman usage env <agent>"));
        return;
      }
      for (const r of rows) {
        console.log(`  ${r.key.padEnd(22)} ${formatCost(r).padStart(10)}  ${dim(`${formatTokens(r.tokens)} tokens`)}`);
      }
      if (foreman) {
        console.log(`  ${"foreman (itself)".padEnd(22)} ${formatUsd(foreman.costUsd).padStart(10)}  ${dim(`${formatTokens(foreman.tokens)} tokens`)}`);
      }
      if (estimated) console.log(dim("  ≈ estimated from list prices (the agent reported tokens, not cost)"));
      if (rows.some((r) => r.unpricedTokens > 0)) {
        console.log(dim("  unpriced: the agent didn't say which model it used; set one with `foreman org add-role … --model` or the agent's model"));
      }
    } finally {
      closeDb();
    }
  });

usageCommand
  .command("env <agent>")
  .description("Show how to make an agent you start yourself report its usage to Foreman")
  .action((agent: string) => {
    requireInitialised();
    const paths = getForemanPaths();
    const id = agent.toLowerCase();
    // A key of this agent's own: what arrives with it is booked to `id`,
    // whatever the payload says (#657).
    const key = agentUsageKey(loadOrCreateUsageKey(paths.root), id);
    const port = otlpPort();
    if (id.includes("codex")) {
      console.log(`${green("✓")} Add this to ${bold("~/.codex/config.toml")}, then restart Codex:`);
      console.log("");
      console.log(codexTelemetrySnippet({ port, key }));
      console.log("");
      console.log(dim("Only token counts are kept. Prompts and responses never reach Foreman."));
      return;
    }
    console.log(`${green("✓")} Add these to your shell profile (or the agent's launcher), then restart ${agent}:`);
    console.log("");
    for (const [k, v] of Object.entries(telemetryEnv({ port, key, agentId: id }))) console.log(`export ${k}=${v}`);
    console.log("");
    console.log(dim("Works for Claude Code; any agent that exports OpenTelemetry logs can use the same endpoint."));
    console.log(dim("Tasks Foreman starts itself (foreman write / assign) are tracked without this."));
  });

function requireInitialised(): void {
  const paths = getForemanPaths();
  if (!existsSync(paths.root)) fail(`Foreman is not initialised at ${paths.root}. Run 'foreman init' first.`);
}

function fail(message: string): never {
  console.error(red("error: ") + message);
  closeDb();
  process.exit(1);
}
