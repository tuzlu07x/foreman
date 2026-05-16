import { existsSync } from "node:fs";
import { Command } from "commander";
import { closeDb, getDb, getSqlite } from "../db/client.js";
import { queryLogs } from "../tui/pages/logs-query.js";
import { getForemanPaths } from "../utils/config.js";
import { red } from "./colors.js";
import {
  renderRequestDetail,
  renderRequestJson,
  renderRequestLine,
} from "./render.js";

function requireInitialised(): void {
  const paths = getForemanPaths();
  if (!existsSync(paths.root)) {
    console.error(
      red("error: ") +
        `Foreman is not initialised at ${paths.root}. Run 'foreman init' first.`,
    );
    process.exit(1);
  }
}

export const logCommand = new Command("log").description(
  "Audit log commands (search / tail / show)",
);

logCommand
  .command("search <query>")
  .description("FTS5 search across recent requests")
  .option("-n, --limit <N>", "max rows", (v) => parseInt(v, 10), 50)
  .option("--json", "output JSON")
  .action((query: string, options: { limit: number; json?: boolean }) => {
    requireInitialised();
    getDb();
    const sqlite = getSqlite();
    const { rows } = queryLogs(sqlite, { search: query, limit: options.limit });
    if (options.json) {
      process.stdout.write(
        JSON.stringify(rows.map(renderRequestJson), null, 2) + "\n",
      );
    } else {
      for (const row of rows) console.log(renderRequestLine(row));
      if (rows.length === 0) console.error(red(`no matches for "${query}"`));
    }
    closeDb();
  });

logCommand
  .command("tail")
  .description("Show the most recent requests")
  .option("-n, --limit <N>", "rows to show", (v) => parseInt(v, 10), 20)
  .option("-f, --follow", "poll for new rows every 2s", false)
  .option("--json", "output JSON")
  .action(
    async (options: { limit: number; follow?: boolean; json?: boolean }) => {
      requireInitialised();
      getDb();
      const sqlite = getSqlite();
      const initial = queryLogs(sqlite, { limit: options.limit });
      if (options.json) {
        process.stdout.write(
          JSON.stringify(initial.rows.map(renderRequestJson), null, 2) + "\n",
        );
      } else if (initial.rows.length === 0) {
        console.log(
          "(no requests logged yet — drive an agent through 'foreman mcp-stdio' or 'foreman wrap' first)",
        );
      } else {
        for (const row of [...initial.rows].reverse())
          console.log(renderRequestLine(row));
      }
      if (!options.follow) {
        closeDb();
        return;
      }
      let seen = new Set(initial.rows.map((r) => r.id));
      const poll = (): void => {
        const next = queryLogs(sqlite, { limit: 100 });
        const fresh = [...next.rows].reverse().filter((r) => !seen.has(r.id));
        for (const row of fresh) {
          if (options.json) {
            process.stdout.write(JSON.stringify(renderRequestJson(row)) + "\n");
          } else {
            console.log(renderRequestLine(row));
          }
          seen.add(row.id);
        }
        if (seen.size > 1000) seen = new Set([...seen].slice(-500));
      };
      const interval = setInterval(poll, 2000);
      const stop = (): void => {
        clearInterval(interval);
        closeDb();
        process.exit(0);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    },
  );

logCommand
  .command("show <requestId>")
  .description("Show full detail for one request")
  .option("--json", "output JSON")
  .action((requestId: string, options: { json?: boolean }) => {
    requireInitialised();
    getDb();
    const sqlite = getSqlite();
    const row = sqlite
      .prepare(`SELECT * FROM requests WHERE id = ?`)
      .get(requestId) as Record<string, unknown> | undefined;
    if (!row) {
      console.error(red("error: ") + `no request with id ${requestId}`);
      closeDb();
      process.exit(1);
    }
    const normalised = {
      id: row.id as string,
      sourceAgent: row.source_agent as string,
      targetAgent: row.target_agent as string | null,
      targetTool: row.target_tool as string | null,
      args: row.args as string,
      riskScore: row.risk_score as number,
      riskReasons: row.risk_reasons as string | null,
      riskFactors: (row.risk_factors ?? null) as string | null,
      riskBucket: (row.risk_bucket ?? null) as
        | "low"
        | "medium"
        | "high"
        | "critical"
        | null,
      llmVerification: (row.llm_verification ?? null) as string | null,
      decision: row.decision as "allowed" | "denied" | "pending",
      decidedBy: row.decided_by as string | null,
      result: row.result as string | null,
      durationMs: row.duration_ms as number | null,
      createdAt: row.created_at as number,
      decidedAt: row.decided_at as number | null,
    };
    if (options.json) {
      process.stdout.write(
        JSON.stringify(renderRequestJson(normalised), null, 2) + "\n",
      );
    } else {
      console.log(renderRequestDetail(normalised));
    }
    closeDb();
  });
