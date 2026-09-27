import { existsSync } from "node:fs";
import type { ForemanDb } from "../../db/client.js";
import type { InboxService } from "../inbox.js";
import { loadOrg } from "../org/org.js";
import { budgetStatus, formatUsd, parsePeriod } from "./report.js";

// =============================================================================
// Department budgets (#629)
// =============================================================================
//
// Every minute, compare each department's spend with its `budget` in
// org.yaml. Crossing 80% and 100% of a daily or monthly limit files one
// inbox item per threshold per period, and is pushed to the alert channels
// when a notifier is wired. With `on_exceed: pause`, agents can't hand new
// work into the department until the period resets (see foreman-command's
// write handler); the owner still can.

export interface BudgetWatcherOptions {
  orgConfigPath: string;
  inbox: InboxService;
  /** Push to the alert channels (budget_alert route). */
  notify?: (title: string, body: string) => void;
  intervalMs?: number;
  now?: () => number;
}

const THRESHOLDS = [0.8, 1] as const;

export class BudgetWatcher {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: ForemanDb,
    private readonly opts: BudgetWatcherOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    this.check();
    this.timer = setInterval(() => this.check(), this.opts.intervalMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass; exposed for tests. */
  check(): void {
    if (!existsSync(this.opts.orgConfigPath)) return;
    let org;
    try {
      org = loadOrg(this.opts.orgConfigPath);
    } catch {
      return;
    }
    if (!org) return;
    const now = (this.opts.now ?? Date.now)();
    for (const [id, dept] of Object.entries(org.departments)) {
      if (!dept.budget) continue;
      let status;
      try {
        status = budgetStatus(this.db, id, dept.budget, now);
      } catch {
        continue;
      }
      for (const c of status.checks) {
        const ratio = c.spentUsd / c.limitUsd;
        const crossed = [...THRESHOLDS].reverse().find((t) => ratio >= t);
        if (!crossed) continue;
        const periodKey = c.period === "day" ? dayKey(now) : monthKey(now);
        const over = crossed >= 1;
        const title = over
          ? `${dept.name} is over its ${c.period === "day" ? "daily" : "monthly"} budget`
          : `${dept.name} has used ${Math.round(ratio * 100)}% of its ${c.period === "day" ? "daily" : "monthly"} budget`;
        const body =
          `${formatUsd(c.spentUsd)} of ${formatUsd(c.limitUsd)} (${parsePeriod(c.period === "day" ? "today" : "month", now)!.label})` +
          (over && status.onExceed === "pause" ? " · agents can't hand it new work until the period resets" : "") +
          ` · change it: foreman org budget ${id} <usd>`;
        const added = this.opts.inbox.add({
          level: over ? "critical" : "warning",
          kind: "budget",
          title,
          body,
          dedupeKey: `org-budget:${id}:${c.period}:${periodKey}:${crossed}`,
        });
        if (added) this.opts.notify?.(title, body);
      }
    }
  }
}

function dayKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function monthKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}`;
}
