import type Database from "better-sqlite3";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { Request } from "../../db/schema.js";
import type { SessionInfo } from "../../core/session.js";
import { useDashboardServices } from "../dashboard-context.js";
import {
  formatDuration,
  formatTime,
  statusIconFor,
  summariseTool,
  targetLabel,
} from "../format.js";
import { singleBorder, theme } from "../theme.js";

export interface SessionsPageProps {
  selectedIdx: number;
  expanded: boolean;
  notice: string | null;
}

const TRANSCRIPT_LIMIT = 12;

export function SessionsPage({
  selectedIdx,
  expanded,
  notice,
}: SessionsPageProps): JSX.Element {
  const { sessionManager, sqlite, bus } = useDashboardServices();
  const [rows, setRows] = useState<SessionInfo[]>(() =>
    sessionManager ? sessionManager.list() : [],
  );
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!sessionManager) return;
    const refresh = (): void => setRows(sessionManager.list());
    const halted = bus.on("session:halted", refresh);
    const decided = bus.on("request:decided", refresh);
    const interval = setInterval(() => {
      setRows(sessionManager.list());
      setTick((t) => t + 1);
    }, 2000);
    return () => {
      halted();
      decided();
      clearInterval(interval);
    };
  }, [sessionManager, bus]);

  if (!sessionManager) {
    return (
      <Box
        flexDirection="column"
        borderStyle={singleBorder()}
        borderDimColor
        paddingX={1}
        flexGrow={1}
      >
        <Text color={theme.accent.danger}>
          SessionManager not wired into App
        </Text>
      </Box>
    );
  }

  const active = rows.filter((r) => r.status === "active");
  const other = rows.filter((r) => r.status !== "active");
  const ordered = [...active, ...other];
  const safeSelected = Math.max(0, Math.min(selectedIdx, ordered.length - 1));

  return (
    <Box
      flexDirection="column"
      borderStyle={singleBorder()}
      borderDimColor
      paddingX={1}
      flexGrow={1}
    >
      <Box justifyContent="space-between">
        <Text color={theme.accent.primary} bold>
          Sessions
        </Text>
        <Text color={theme.fg.muted}>
          {active.length} active · {other.length} other
        </Text>
      </Box>

      {ordered.length === 0 ? (
        <Box marginTop={1}>
          <Text color={theme.fg.muted}>(no sessions yet)</Text>
        </Box>
      ) : (
        <>
          {active.length > 0 && <Section title="Active" status="active" />}
          <Box flexDirection="column">
            {ordered.map((session, i) => {
              const isSelected = i === safeSelected;
              const showOtherHeader = active.length > 0 && i === active.length;
              return (
                <Box flexDirection="column" key={session.id}>
                  {showOtherHeader && (
                    <Section title="Completed / halted" status="other" />
                  )}
                  <SessionRow
                    session={session}
                    selected={isSelected}
                    expanded={expanded && isSelected}
                    sqlite={sqlite}
                    tick={tick}
                  />
                </Box>
              );
            })}
          </Box>
        </>
      )}

      {notice && (
        <Box marginTop={1}>
          <Text color={theme.accent.success}>{notice}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.fg.muted}>{"─".repeat(60)}</Text>
      </Box>
      <Text color={theme.fg.muted}>
        [↑↓] move · [Enter] transcript · [k] halt · [Esc] back
      </Text>
    </Box>
  );
}

function Section({
  title,
  status,
}: {
  title: string;
  status: "active" | "other";
}): JSX.Element {
  return (
    <Box marginTop={1}>
      <Text color={status === "active" ? theme.accent.success : theme.fg.muted}>
        {status === "active" ? theme.symbols.activeDot : theme.symbols.idleDot}{" "}
        {title}
      </Text>
    </Box>
  );
}

function SessionRow({
  session,
  selected,
  expanded,
  sqlite,
  tick,
}: {
  session: SessionInfo;
  selected: boolean;
  expanded: boolean;
  sqlite: Database.Database;
  tick: number;
}): JSX.Element {
  const isActive = session.status === "active";
  const isHalted = session.status === "halted";
  const dot = isActive ? theme.symbols.activeDot : theme.symbols.idleDot;
  const dotColor = isActive
    ? theme.accent.success
    : isHalted
      ? theme.accent.danger
      : theme.fg.muted;
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={selected ? theme.accent.primary : theme.fg.muted}>
          {selected ? "▸ " : "  "}
        </Text>
        <Text color={dotColor}>{dot}</Text>{" "}
        <Text color={theme.accent.primary}>
          {session.participants.join(" ⇄ ")}
        </Text>{" "}
        <Text color={theme.fg.muted}>
          · {session.messageCount} turn{session.messageCount === 1 ? "" : "s"} ·{" "}
          {session.tokenCount} tok · {session.status}
        </Text>
      </Text>
      {expanded && (
        <SessionDetail session={session} sqlite={sqlite} tick={tick} />
      )}
    </Box>
  );
}

function SessionDetail({
  session,
  sqlite,
  tick,
}: {
  session: SessionInfo;
  sqlite: Database.Database;
  tick: number;
}): JSX.Element {
  const transcript = querySessionTranscript(sqlite, session);
  void tick;
  return (
    <Box
      flexDirection="column"
      marginLeft={2}
      marginBottom={1}
      paddingX={1}
      borderStyle={singleBorder()}
      borderDimColor
    >
      <Text color={theme.fg.muted}>session id: {session.id}</Text>
      <Text color={theme.fg.muted}>
        started {formatTime(session.startedAt)}
        {session.endedAt ? ` · ended ${formatTime(session.endedAt)}` : ""}
      </Text>
      <Box marginTop={1}>
        <Text color={theme.fg.muted}>
          Transcript (last {Math.min(TRANSCRIPT_LIMIT, transcript.length)}):
        </Text>
      </Box>
      {transcript.length === 0 ? (
        <Text color={theme.fg.muted}> (no requests recorded yet)</Text>
      ) : (
        transcript.map((row) => <TranscriptLine key={row.id} row={row} />)
      )}
    </Box>
  );
}

function TranscriptLine({ row }: { row: Request }): JSX.Element {
  const status = statusIconFor(row.decision);
  const toneColor =
    status.tone === "success"
      ? theme.accent.success
      : status.tone === "danger"
        ? theme.accent.danger
        : theme.accent.warning;
  return (
    <Text>
      {"  "}
      <Text color={theme.fg.muted}>[{formatTime(row.createdAt)}]</Text>{" "}
      <Text color={theme.accent.primary}>
        {targetLabel(row.sourceAgent, row.targetAgent)}
      </Text>{" "}
      <Text>{summariseTool(row.targetTool, row.args)}</Text>{" "}
      <Text color={toneColor}>{status.icon}</Text>{" "}
      <Text color={theme.fg.muted}>
        {row.decision}
        {row.durationMs !== null ? ` · ${formatDuration(row.durationMs)}` : ""}
      </Text>
    </Text>
  );
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
}

export function querySessionTranscript(
  sqlite: Database.Database,
  session: SessionInfo,
): Request[] {
  if (session.participants.length === 0) return [];
  const placeholders = session.participants.map(() => "?").join(", ");
  const params: (string | number)[] = [
    ...session.participants,
    ...session.participants,
    session.startedAt,
  ];
  let endClause = "";
  if (session.endedAt !== null) {
    endClause = "AND created_at <= ?";
    params.push(session.endedAt + 2000);
  }
  const sql = `
    SELECT * FROM requests
    WHERE (source_agent IN (${placeholders}) OR target_agent IN (${placeholders}))
    AND created_at >= ?
    ${endClause}
    ORDER BY created_at ASC
    LIMIT ${TRANSCRIPT_LIMIT}
  `;
  const rows = sqlite.prepare(sql).all(...params) as RawRow[];
  return rows.map((row) => ({
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
  }));
}
