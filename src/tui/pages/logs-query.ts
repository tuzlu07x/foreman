import type Database from "better-sqlite3";
import type { Request } from "../../db/schema.js";

export interface LogFilters {
  allowed: boolean;
  denied: boolean;
  ask: boolean;
  errored: boolean;
}

export const DEFAULT_FILTERS: LogFilters = {
  allowed: true,
  denied: true,
  ask: true,
  errored: true,
};

export interface QueryOptions {
  search?: string;
  filters?: LogFilters;
  limit?: number;
  /** Filter rows by session_id (#301). When set, returns rows whose
   *  session_id column equals this value — used by the
   *  `foreman log tail --session <id>` flag and (later) the TUI sessions
   *  tree view. */
  sessionId?: string;
}

const ERROR_DECIDED_BY = ["auth-failure", "route-error"];

export interface LogQueryResult {
  rows: Request[];
  total: number;
}

export function queryLogs(
  sqlite: Database.Database,
  options: QueryOptions = {},
): LogQueryResult {
  const { search, filters = DEFAULT_FILTERS, limit = 200, sessionId } = options;
  const where: string[] = [];
  const params: (string | number)[] = [];

  const filterSql = buildFilterClause(filters, params);
  if (filterSql) where.push(filterSql);

  if (sessionId && sessionId.length > 0) {
    where.push("requests.session_id = ?");
    params.push(sessionId);
  }

  let joinSql = "";
  if (search && search.trim().length > 0) {
    joinSql = "JOIN requests_fts ON requests_fts.request_id = requests.id";
    where.push("requests_fts MATCH ?");
    params.push(toFtsQuery(search.trim()));
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    SELECT requests.* FROM requests
    ${joinSql}
    ${whereSql}
    ORDER BY requests.created_at DESC
    LIMIT ?
  `;
  params.push(limit);

  const rows = sqlite.prepare(sql).all(...params) as RawRow[];
  return { rows: rows.map(rowToRequest), total: rows.length };
}

export function toFtsQuery(text: string): string {
  const safe = text.replace(/[^a-zA-Z0-9_.\-]/g, " ").trim();
  if (!safe) return text;
  return safe
    .split(/\s+/)
    .map((token) => (token.includes(".") ? `"${token}"` : `${token}*`))
    .join(" ");
}

export function buildFilterClause(
  filters: LogFilters,
  params: (string | number)[],
): string | null {
  if (allTrue(filters)) return null;
  const clauses: string[] = [];
  if (filters.allowed) {
    clauses.push(
      `(requests.decision = 'allowed' AND requests.decided_by NOT IN (${placeholders(ERROR_DECIDED_BY, params)}))`,
    );
  }
  if (filters.denied) {
    clauses.push(
      `(requests.decision = 'denied' AND requests.decided_by NOT IN (${placeholders(ERROR_DECIDED_BY, params)}))`,
    );
  }
  if (filters.ask) {
    clauses.push(`requests.decided_by LIKE 'user%'`);
  }
  if (filters.errored) {
    clauses.push(
      `requests.decided_by IN (${placeholders(ERROR_DECIDED_BY, params)})`,
    );
  }
  if (clauses.length === 0) return "1=0";
  return `(${clauses.join(" OR ")})`;
}

export function toJsonl(rows: Request[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function allTrue(f: LogFilters): boolean {
  return f.allowed && f.denied && f.ask && f.errored;
}

function placeholders(values: string[], params: (string | number)[]): string {
  const slots: string[] = [];
  for (const v of values) {
    params.push(v);
    slots.push("?");
  }
  return slots.join(", ");
}

interface RawRow {
  id: string;
  source_agent: string;
  target_agent: string | null;
  target_tool: string | null;
  args: string;
  risk_score: number;
  risk_reasons: string | null;
  risk_factors: string | null;
  risk_bucket: "low" | "medium" | "high" | "critical" | null;
  llm_verification: string | null;
  security_report: string | null;
  decision: "allowed" | "denied" | "pending";
  decided_by: string | null;
  result: string | null;
  duration_ms: number | null;
  created_at: number;
  decided_at: number | null;
  parent_request_id: string | null;
  session_id: string | null;
}

function rowToRequest(row: RawRow): Request {
  return {
    id: row.id,
    sourceAgent: row.source_agent,
    targetAgent: row.target_agent,
    targetTool: row.target_tool,
    args: row.args,
    riskScore: row.risk_score,
    riskReasons: row.risk_reasons,
    riskFactors: row.risk_factors ?? null,
    riskBucket: row.risk_bucket ?? null,
    llmVerification: row.llm_verification ?? null,
    securityReport: row.security_report ?? null,
    decision: row.decision,
    decidedBy: row.decided_by,
    result: row.result,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    parentRequestId: row.parent_request_id,
    sessionId: row.session_id,
  };
}
