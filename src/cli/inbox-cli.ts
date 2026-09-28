import { existsSync } from "node:fs";
import { Command } from "commander";
import { readForemanPid } from "../core/foreman-pidfile.js";
import {
  InboxService,
  recordMissedApprovals,
  stripControl,
  waitingApprovalCount,
} from "../core/inbox.js";
import { closeDb, getDb, type ForemanDb } from "../db/client.js";
import { relativeTime } from "../tui/format.js";
import { getForemanPaths } from "../utils/config.js";
import { bold, dim, green, orange, red } from "./colors.js";

// =============================================================================
// foreman inbox — the TUI notification centre from any shell (#613)
// =============================================================================
//
//   foreman inbox              newest 20, unread marked with ●
//   foreman inbox --unread     only what you haven't seen
//   foreman inbox --json       for scripts
//   foreman inbox read         mark everything read

export const inboxCommand = new Command("inbox").description(
  "What Foreman wanted you to know: approvals, blocked calls, crashed agents, updates",
);

inboxCommand
  .option("--unread", "only unread items")
  .option("--limit <n>", "how many items", (v) => Number.parseInt(v, 10), 20)
  .option("--json", "machine-readable output")
  .action((opts: { unread?: boolean; limit: number; json?: boolean }) => {
    withInbox((inbox, db) => {
      // Approvals that timed out with no `foreman start` to show them (#657).
      recordMissedApprovals(db, inbox);
      const items = inbox.list({ limit: opts.limit, unreadOnly: opts.unread === true });
      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }
      const unread = inbox.unreadCount();
      const waiting = waitingApprovalCount(db);
      const status =
        unread > 0 ? orange(`${unread} unread`) : waiting > 0 ? "" : green("all caught up");
      console.log(`${orange(bold("Inbox"))}  ${status}`.trimEnd());
      if (waiting > 0) {
        const where = readForemanPid(getForemanPaths().configDir)
          ? "answer in the `foreman start` window"
          : "run `foreman start` to answer before they time out";
        console.log(orange(`  ⚠ ${waiting} approval${waiting === 1 ? "" : "s"} waiting — ${where}`));
      }
      if (items.length === 0) {
        console.log(dim("  Nothing here yet."));
        return;
      }
      const now = Date.now();
      for (const item of items) {
        const glyph =
          item.level === "critical" ? red("✗") : item.level === "warning" ? orange("⚠") : dim("▸");
        const dot = item.readAt === null ? orange("●") : " ";
        // Items can quote agent output; never pass escape sequences through.
        console.log(`${dot} ${glyph} ${stripControl(item.title)}  ${dim(relativeTime(item.createdAt, now))}`);
        if (item.body) console.log(dim(`      ${stripControl(item.body)}`));
      }
    });
  });

inboxCommand
  .command("read")
  .description("Mark every item read")
  .action(() => {
    withInbox((inbox) => {
      const n = inbox.markAllRead();
      console.log(`${green("✓")} marked ${n} item${n === 1 ? "" : "s"} read`);
    });
  });

function withInbox(run: (inbox: InboxService, db: ForemanDb) => void): void {
  const paths = getForemanPaths();
  if (!existsSync(paths.root)) {
    console.error(`${red("error:")} Foreman is not initialised. Run 'foreman init' first.`);
    process.exit(1);
  }
  try {
    const db = getDb();
    run(new InboxService(db), db);
  } finally {
    closeDb();
  }
}
