/**
 * `foreman delegations` CLI — operator visibility into the multi-agent
 * loop tracker (PR B of the autonomous loop enforcement epic).
 *
 * Subcommands:
 *   foreman delegations list                # active rows, newest first
 *   foreman delegations list --recent       # last N regardless of status
 *   foreman delegations list --agent <id>   # filter by initiator or target
 *   foreman delegations show <id>           # full row + lifecycle timeline
 *
 * Pure read surface — does not mutate state. The watchdog in
 * `foreman start` drives the actual nudges + escalations; this CLI
 * is for "what's the orchestration doing right now?"
 */

import { Command } from "commander";
import { closeDb, getDb } from "../db/client.js";
import { DelegationTracker } from "../core/delegation-tracker.js";
import type { Delegation } from "../db/schema.js";
import { bold, dim, green, orange, red } from "./colors.js";

export const delegationsCommand = new Command("delegations").description(
  "Inspect the multi-agent delegation tracker (autonomous loop status)",
);

delegationsCommand
  .command("list")
  .description(
    "List delegations. Default: active rows only (status != closed/abandoned), newest first.",
  )
  .option("--recent", "include ALL delegations regardless of status")
  .option(
    "--agent <id>",
    "filter to rows where this agent is either the initiator or the target",
  )
  .option(
    "--limit <n>",
    "max rows to print (default 50; capped at 200)",
    (value) => Number(value),
    50,
  )
  .option("--json", "machine-readable output (one JSON array)")
  .action(
    (options: {
      recent?: boolean;
      agent?: string;
      limit?: number;
      json?: boolean;
    }) => {
      const db = getDb();
      try {
        const tracker = new DelegationTracker({ db });
        const limit = Math.min(Math.max(1, options.limit ?? 50), 200);
        let rows: Delegation[];
        if (options.agent) {
          rows = tracker.recentForAgent(options.agent, limit);
          if (!options.recent) {
            rows = rows.filter(
              (r) => r.status !== "closed" && r.status !== "abandoned",
            );
          }
        } else if (options.recent) {
          rows = tracker.recent(limit);
        } else {
          rows = tracker.activeAcrossAgents(limit);
        }

        if (options.json) {
          process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
          return;
        }

        if (rows.length === 0) {
          console.log(
            dim("no delegations") +
              (options.recent || options.agent
                ? ""
                : " — try `--recent` to include closed/abandoned rows."),
          );
          return;
        }

        console.log(bold(headerLine()));
        for (const row of rows) {
          console.log(formatRow(row));
        }
      } finally {
        closeDb();
      }
    },
  );

delegationsCommand
  .command("show <id>")
  .description("Print the full row + lifecycle timeline for one delegation")
  .option("--json", "machine-readable output (one JSON object)")
  .action((id: string, options: { json?: boolean }) => {
    const db = getDb();
    try {
      const tracker = new DelegationTracker({ db });
      const row = tracker.find(id);
      if (!row) {
        console.error(red("error: ") + `no delegation with id "${id}"`);
        process.exitCode = 2;
        return;
      }
      if (options.json) {
        process.stdout.write(JSON.stringify(row, null, 2) + "\n");
        return;
      }
      console.log(bold("Delegation") + " " + dim(row.id));
      console.log(
        "  " + dim("initiator → target  ") + row.initiatorAgent + " → " + row.targetAgent,
      );
      console.log("  " + dim("status              ") + statusLabel(row.status));
      console.log(
        "  " + dim("prompt              ") + truncate(row.promptSummary, 100),
      );
      if (row.spawnOutcome) {
        console.log("  " + dim("spawn outcome       ") + row.spawnOutcome);
      }
      if (row.controlCommandId !== null && row.controlCommandId !== undefined) {
        console.log(
          "  " + dim("control command id  ") + String(row.controlCommandId),
        );
      }
      console.log("");
      console.log(bold("Timeline"));
      console.log("  " + dim("started_at          ") + formatTime(row.startedAt));
      if (row.outputReceivedAt !== null) {
        console.log(
          "  " +
            dim("output_received_at  ") +
            formatTime(row.outputReceivedAt) +
            "  (" +
            durationSince(row.startedAt, row.outputReceivedAt) +
            " after start)",
        );
      } else {
        console.log("  " + dim("output_received_at  ") + dim("—  (in flight)"));
      }
      if (row.lastNudgeAt !== null) {
        console.log(
          "  " +
            dim("last_nudge_at       ") +
            formatTime(row.lastNudgeAt) +
            "  (count=" +
            String(row.nudgeCount) +
            ")",
        );
      } else {
        console.log("  " + dim("nudges              ") + dim("0  (never nudged)"));
      }
      if (row.followUpAt !== null) {
        console.log(
          "  " + dim("follow_up_at        ") + formatTime(row.followUpAt),
        );
      } else {
        console.log("  " + dim("follow_up_at        ") + dim("—"));
      }
    } finally {
      closeDb();
    }
  });

// =============================================================================
// Formatting helpers — kept inline so the CLI stays self-contained.
// =============================================================================

function headerLine(): string {
  return [
    "STATUS".padEnd(11),
    "AGE".padEnd(8),
    "INITIATOR".padEnd(14),
    "TARGET".padEnd(14),
    "OUTPUT".padEnd(9),
    "NUDGES".padEnd(7),
    "PROMPT",
  ].join(" ");
}

function formatRow(row: Delegation): string {
  const age = humanAge(Date.now() - row.startedAt);
  const output =
    row.outputReceivedAt === null
      ? dim("waiting")
      : row.spawnOutcome ?? "?";
  return [
    statusLabel(row.status).padEnd(11 + 12), // padding accounts for ANSI escapes
    age.padEnd(8),
    row.initiatorAgent.padEnd(14),
    row.targetAgent.padEnd(14),
    output.padEnd(9),
    String(row.nudgeCount).padEnd(7),
    truncate(row.promptSummary, 50),
  ].join(" ");
}

function statusLabel(status: Delegation["status"]): string {
  switch (status) {
    case "open":
      return dim("open");
    case "awaiting":
      return orange("awaiting");
    case "nudged":
      return orange("nudged");
    case "escalated":
      return red("escalated");
    case "closed":
      return green("closed");
    case "abandoned":
      return dim("abandoned");
    default:
      return status;
  }
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function humanAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function durationSince(start: number, end: number): string {
  return humanAge(end - start);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
