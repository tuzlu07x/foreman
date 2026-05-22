import { and, desc, eq, gte, sql } from "drizzle-orm";
import { useEffect, useState } from "react";
import type { ForemanDb } from "../db/client.js";
import type { RegisteredAgent, RegistryService } from "../core/registry.js";
import {
  controlCommands,
  requests,
  sessions,
  type ControlCommand,
  type Request,
} from "../db/schema.js";
import { useDashboardServices } from "./dashboard-context.js";
import {
  aggregateStats,
  startOfTodayMs,
  type DecisionStats,
} from "./format.js";

const RECENT_LIMIT = 50;
const CONTROL_RECENT_LIMIT = 20;
const POLL_INTERVAL_MS = 2000;

export interface PendingRequest {
  requestId: string;
  sourceAgent: string;
  targetTool?: string;
}

export interface DashboardState {
  agents: RegisteredAgent[];
  recentRequests: Request[];
  /** #498 — Recent control_commands rows (write / stop / llm switch).
   *  Surfaced in the Activity feed alongside policy requests so the
   *  TUI shows orchestration directives as they happen. */
  recentControlCommands: ControlCommand[];
  pendingRequests: PendingRequest[];
  todayStats: DecisionStats;
  perAgentToday: Record<string, number>;
  activeSessions: number;
}

export function useDashboardState(): DashboardState {
  const { db, bus, registry } = useDashboardServices();
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [state, setState] = useState<Omit<DashboardState, "pendingRequests">>(
    () => collectState(db, registry),
  );

  useEffect(() => {
    const refresh = (): void => setState(collectState(db, registry));
    const onReceived = (e: {
      requestId: string;
      sourceAgent: string;
      targetTool?: string;
    }): void => {
      setPending((prev) => {
        if (prev.some((p) => p.requestId === e.requestId)) return prev;
        return [
          ...prev,
          {
            requestId: e.requestId,
            sourceAgent: e.sourceAgent,
            targetTool: e.targetTool,
          },
        ];
      });
      refresh();
    };
    const onDecided = (e: { requestId: string }): void => {
      setPending((prev) => prev.filter((p) => p.requestId !== e.requestId));
      refresh();
    };
    const unsubs = [
      bus.on("request:received", onReceived),
      bus.on("request:decided", onDecided),
      bus.on("agent:registered", refresh),
      bus.on("agent:heartbeat", refresh),
      bus.on("session:halted", refresh),
      // #498 — Orchestration directive lifecycle. Each event triggers
      // a refresh so the Activity feed reflects the status transition
      // instantly (drain handler runs in this same process). Cross-
      // process enqueues (mcp-stdio / CLI write) are still picked up by
      // the 2s poll below.
      bus.on("control:enqueued", refresh),
      bus.on("control:applied", refresh),
      bus.on("control:failed", refresh),
    ];
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      for (const off of unsubs) off();
      clearInterval(interval);
    };
  }, [db, bus, registry]);

  return { ...state, pendingRequests: pending };
}

function collectState(
  db: ForemanDb,
  registry: RegistryService,
): Omit<DashboardState, "pendingRequests"> {
  const todayStart = startOfTodayMs();
  const agents = registry.list();
  const recentRequests = db
    .select()
    .from(requests)
    .orderBy(desc(requests.createdAt))
    .limit(RECENT_LIMIT)
    .all();
  // #498 — Mirror the chat-side /foreman activity ordering: newest
  // created_at first, ties broken by id desc so same-millisecond rows
  // come back in insertion order.
  const recentControlCommands = db
    .select()
    .from(controlCommands)
    .orderBy(desc(controlCommands.createdAt), desc(controlCommands.id))
    .limit(CONTROL_RECENT_LIMIT)
    .all();
  const todayRows = db
    .select({ decision: requests.decision, sourceAgent: requests.sourceAgent })
    .from(requests)
    .where(gte(requests.createdAt, todayStart))
    .all();
  const todayStats = aggregateStats(todayRows);
  const perAgentToday: Record<string, number> = {};
  for (const r of todayRows) {
    perAgentToday[r.sourceAgent] = (perAgentToday[r.sourceAgent] ?? 0) + 1;
  }
  const sessionRow = db
    .select({ count: sql<number>`count(*)` })
    .from(sessions)
    .where(eq(sessions.status, "active"))
    .get();
  return {
    agents,
    recentRequests,
    recentControlCommands,
    todayStats,
    perAgentToday,
    activeSessions: sessionRow?.count ?? 0,
  };
}

// Drizzle's `and` is imported above so future filters compose cleanly.
void and;
