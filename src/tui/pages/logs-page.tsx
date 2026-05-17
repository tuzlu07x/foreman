import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Box, Text } from "ink";
import { useEffect, useMemo, useState } from "react";
import type { Request } from "../../db/schema.js";
import { useDashboardServices } from "../dashboard-context.js";
import {
  formatTime,
  formatDuration,
  statusIconFor,
  summariseTool,
  targetLabel,
} from "../format.js";
import { singleBorder, theme } from "../theme.js";
import { EmptyState } from "../components/empty-state.js";
import { PageHeader } from "../components/typography.js";
import {
  DEFAULT_FILTERS,
  queryLogs,
  toJsonl,
  type LogFilters,
} from "./logs-query.js";

export interface LogsPageProps {
  search: string;
  searchMode: boolean;
  filters: LogFilters;
  selectedIdx: number;
  expanded: boolean;
  exportNotice: string | null;
  replayNotice: string | null;
}

const VISIBLE_ROWS = 12;

export function LogsPage(props: LogsPageProps): JSX.Element {
  const {
    search,
    searchMode,
    filters,
    selectedIdx,
    expanded,
    exportNotice,
    replayNotice,
  } = props;
  const { sqlite } = useDashboardServices();
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setRefreshKey((k) => k + 1), 2000);
    return () => clearInterval(t);
  }, []);

  const results = useMemo(
    () => queryLogs(sqlite, { search, filters, limit: 200 }).rows,
    // refreshKey forces re-query on the 2s tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sqlite, search, filters, refreshKey],
  );

  const safeSelected = Math.max(0, Math.min(selectedIdx, results.length - 1));
  const offsetStart = Math.max(
    0,
    Math.min(
      results.length - VISIBLE_ROWS,
      safeSelected - Math.floor(VISIBLE_ROWS / 2),
    ),
  );
  const visible = results.slice(offsetStart, offsetStart + VISIBLE_ROWS);

  return (
    <Box
      flexDirection="column"
      borderStyle={singleBorder()}
      borderDimColor
      paddingX={1}
      flexGrow={1}
    >
      <PageHeader
        title="Logs"
        right={`${results.length} match${results.length === 1 ? "" : "es"}`}
      />

      <SearchBar query={search} active={searchMode} />
      <FilterBar filters={filters} />

      <Box flexDirection="column" marginTop={1}>
        {results.length === 0 ? (
          <EmptyState
            title="No requests logged yet"
            body="Foreman audits every tool call (allowed, denied, asked). Once an agent makes a request, you'll see it here with full risk factors, the decision, and a one-key replay."
            commands={[
              "foreman wrap --name claude-code -- claude",
              "foreman mcp-stdio  # let an agent connect",
            ]}
            hotkeys={["[/] search · [1-4] filter · [Esc] back"]}
          />
        ) : (
          visible.map((row, i) => {
            const absoluteIdx = offsetStart + i;
            const isSelected = absoluteIdx === safeSelected;
            return (
              <ResultRow
                key={row.id}
                row={row}
                selected={isSelected}
                expanded={expanded && isSelected}
              />
            );
          })
        )}
      </Box>

      {(exportNotice || replayNotice) && (
        <Box marginTop={1}>
          {exportNotice && (
            <Text color={theme.accent.success}>{exportNotice}</Text>
          )}
          {replayNotice && (
            <Text color={theme.accent.warning}>{replayNotice}</Text>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.fg.muted}>{"─".repeat(60)}</Text>
      </Box>
      <Text color={theme.fg.muted}>
        [/] search · [1-4] toggle filter · [↑↓] move · [Enter] inspect · [r]
        replay · [e] export · [Esc] back
      </Text>
    </Box>
  );
}

function SearchBar({
  query,
  active,
}: {
  query: string;
  active: boolean;
}): JSX.Element {
  return (
    <Box>
      <Text color={active ? theme.accent.primary : theme.fg.muted}>
        {active ? "› " : "  "}
      </Text>
      <Text color={active ? theme.fg.emphasis : theme.fg.muted}>
        {query.length > 0 ? query : "(type / to search)"}
      </Text>
      {active && <Text color={theme.accent.primary}>▌</Text>}
    </Box>
  );
}

function FilterBar({ filters }: { filters: LogFilters }): JSX.Element {
  const items: { key: keyof LogFilters; label: string; n: number }[] = [
    { key: "allowed", label: "allowed", n: 1 },
    { key: "denied", label: "denied", n: 2 },
    { key: "ask", label: "ask", n: 3 },
    { key: "errored", label: "errored", n: 4 },
  ];
  return (
    <Box>
      <Text color={theme.fg.muted}>Filter: </Text>
      {items.map((it, i) => (
        <Text key={it.key}>
          {i > 0 ? "  " : ""}
          <Text color={theme.fg.muted}>[{it.n}]</Text>{" "}
          <Text color={filters[it.key] ? theme.accent.success : theme.fg.muted}>
            {filters[it.key] ? "▣" : "☐"}
          </Text>{" "}
          <Text color={filters[it.key] ? undefined : theme.fg.muted}>
            {it.label}
          </Text>
        </Text>
      ))}
    </Box>
  );
}

function ResultRow({
  row,
  selected,
  expanded,
}: {
  row: Request;
  selected: boolean;
  expanded: boolean;
}): JSX.Element {
  const status = statusIconFor(row.decision);
  const toneColor =
    status.tone === "success"
      ? theme.accent.success
      : status.tone === "danger"
        ? theme.accent.danger
        : theme.accent.warning;
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={selected ? theme.accent.primary : theme.fg.muted}>
          {selected ? "▸ " : "  "}
        </Text>
        <Text color={theme.fg.muted}>[{formatTime(row.createdAt)}]</Text>{" "}
        <Text color={theme.accent.primary}>
          {targetLabel(row.sourceAgent, row.targetAgent)}
        </Text>{" "}
        <Text bold={selected}>{summariseTool(row.targetTool, row.args)}</Text>{" "}
        <Text color={toneColor}>{status.icon}</Text>{" "}
        <Text color={theme.fg.muted}>
          {row.decision}
          {row.decidedBy ? ` · ${row.decidedBy}` : ""}
          {row.durationMs !== null
            ? ` · ${formatDuration(row.durationMs)}`
            : ""}
        </Text>
      </Text>
      {expanded && (
        <Box
          flexDirection="column"
          marginLeft={2}
          marginBottom={1}
          paddingX={1}
          borderStyle={singleBorder()}
          borderDimColor
        >
          <Text color={theme.fg.muted}>id: {row.id}</Text>
          {row.riskScore > 0 && (
            <Text color={theme.fg.muted}>risk: {row.riskScore}/100</Text>
          )}
          {row.riskReasons && (
            <Text color={theme.fg.muted}>reasons: {row.riskReasons}</Text>
          )}
        </Box>
      )}
    </Box>
  );
}

export interface ExportResult {
  path: string;
  count: number;
}

export function exportLogs(rows: Request[]): ExportResult {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_");
  const path = resolve(process.cwd(), `foreman-export-${ts}.jsonl`);
  writeFileSync(path, toJsonl(rows));
  return { path, count: rows.length };
}
