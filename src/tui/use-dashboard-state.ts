import { and, desc, eq, gte, sql } from "drizzle-orm";
import { useEffect, useState } from "react";
import type { ForemanDb } from "../db/client.js";
import type { RegisteredAgent, RegistryService } from "../core/registry.js";
import { requests, sessions, type Request } from "../db/schema.js";
import { useDashboardServices } from "./dashboard-context.js";
import {
  aggregateStats,
  startOfTodayMs,
  type DecisionStats,
} from "./format.js";

const RECENT_LIMIT = 50;
const POLL_INTERVAL_MS = 2000;

export interface DashboardState {
  agents: RegisteredAgent[];
  recentRequests: Request[];
  todayStats: DecisionStats;
  perAgentToday: Record<string, number>;
  activeSessions: number;
}

export function useDashboardState(): DashboardState {
  const { db, bus, registry } = useDashboardServices();
  const [state, setState] = useState<DashboardState>(() =>
    collectState(db, registry),
  );

  useEffect(() => {
    const refresh = (): void => setState(collectState(db, registry));
    const unsubs = [
      bus.on("request:decided", refresh),
      bus.on("request:received", refresh),
      bus.on("agent:registered", refresh),
      bus.on("agent:heartbeat", refresh),
      bus.on("session:halted", refresh),
    ];
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      for (const off of unsubs) off();
      clearInterval(interval);
    };
  }, [db, bus, registry]);

  return state;
}

function collectState(
  db: ForemanDb,
  registry: RegistryService,
): DashboardState {
  const todayStart = startOfTodayMs();
  const agents = registry.list();
  const recentRequests = db
    .select()
    .from(requests)
    .orderBy(desc(requests.createdAt))
    .limit(RECENT_LIMIT)
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
    todayStats,
    perAgentToday,
    activeSessions: sessionRow?.count ?? 0,
  };
}

// Drizzle's `and` is imported above so future filters compose cleanly.
void and;
