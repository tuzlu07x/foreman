/**
 * TUI "Delegations" page — live view of the multi-agent autonomous
 * loop tracker. Each row is one `foreman write <peer> <task>`
 * delegation; the operator sees what's awaiting follow-up, what got
 * nudged, what escalated.
 *
 * Reads `delegations` table via the DelegationTracker. Refreshes
 * every 2s (same cadence as the Sessions page) so nudges appear
 * within ~the watchdog tick window. Pure read surface — does not
 * mutate state.
 */

import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { Delegation } from "../../db/schema.js";
import { DelegationTracker } from "../../core/delegation-tracker.js";
import { useDashboardServices } from "../dashboard-context.js";
import { singleBorder, theme } from "../theme.js";
import { EmptyState } from "../components/empty-state.js";
import { PageHeader } from "../components/typography.js";

export interface DelegationsPageProps {
  selectedIdx: number;
  expanded: boolean;
  notice: string | null;
}

const POLL_INTERVAL_MS = 2_000;
const PAGE_LIMIT = 30;

export function DelegationsPage({
  selectedIdx,
  expanded,
  notice,
}: DelegationsPageProps): JSX.Element {
  const { db } = useDashboardServices();
  const [tracker] = useState<DelegationTracker | null>(() =>
    db ? new DelegationTracker({ db }) : null,
  );
  const [rows, setRows] = useState<Delegation[]>(() =>
    tracker ? tracker.activeAcrossAgents(PAGE_LIMIT) : [],
  );

  useEffect(() => {
    if (!tracker) return undefined;
    const refresh = (): void =>
      setRows(tracker.activeAcrossAgents(PAGE_LIMIT));
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [tracker]);

  if (!tracker) {
    return (
      <Box
        flexDirection="column"
        borderStyle={singleBorder()}
        borderDimColor
        paddingX={1}
        flexGrow={1}
      >
        <Text color={theme.accent.danger}>
          DelegationTracker not wired into App (db missing)
        </Text>
      </Box>
    );
  }

  const awaiting = rows.filter((r) => r.status === "awaiting").length;
  const nudged = rows.filter((r) => r.status === "nudged").length;
  const escalated = rows.filter((r) => r.status === "escalated").length;
  const safeSelected = Math.max(0, Math.min(selectedIdx, rows.length - 1));

  return (
    <Box
      flexDirection="column"
      borderStyle={singleBorder()}
      borderDimColor
      paddingX={1}
      flexGrow={1}
    >
      <PageHeader
        title="Delegations"
        right={`${awaiting} awaiting · ${nudged} nudged · ${escalated} escalated`}
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No active delegations"
          body={
            "Every `foreman write <agent> <task>` directive shows up here while the chain " +
            "is in flight. Foreman auto-closes a row when the initiator follows up, and " +
            "nudges the initiator if they go idle past the threshold (default 30s)."
          }
          commands={[
            "foreman delegations list             # CLI view of the same data",
            "foreman delegations list --recent   # include closed/abandoned rows",
            "foreman delegations show <id>       # full lifecycle + timeline",
          ]}
          hotkeys={["[Esc] back to dashboard"]}
        />
      ) : (
        <Box flexDirection="column">
          <HeaderRow />
          {rows.map((row, i) => (
            <DelegationRow
              key={row.id}
              row={row}
              selected={i === safeSelected}
              expanded={expanded && i === safeSelected}
            />
          ))}
        </Box>
      )}

      {notice && (
        <Box marginTop={1}>
          <Text color={theme.accent.warning}>{notice}</Text>
        </Box>
      )}
    </Box>
  );
}

function HeaderRow(): JSX.Element {
  return (
    <Box>
      <Box width={10}>
        <Text dimColor>STATUS</Text>
      </Box>
      <Box width={8}>
        <Text dimColor>AGE</Text>
      </Box>
      <Box width={14}>
        <Text dimColor>INITIATOR</Text>
      </Box>
      <Box width={14}>
        <Text dimColor>TARGET</Text>
      </Box>
      <Box width={9}>
        <Text dimColor>OUTPUT</Text>
      </Box>
      <Box width={7}>
        <Text dimColor>NUDGES</Text>
      </Box>
      <Box flexGrow={1}>
        <Text dimColor>PROMPT</Text>
      </Box>
    </Box>
  );
}

interface DelegationRowProps {
  row: Delegation;
  selected: boolean;
  expanded: boolean;
}

function DelegationRow({
  row,
  selected,
  expanded,
}: DelegationRowProps): JSX.Element {
  const statusColor = statusColorFor(row.status);
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={10}>
          <Text color={statusColor}>{selected ? "› " : "  "}{row.status}</Text>
        </Box>
        <Box width={8}>
          <Text>{humanAge(Date.now() - row.startedAt)}</Text>
        </Box>
        <Box width={14}>
          <Text>{truncate(row.initiatorAgent, 13)}</Text>
        </Box>
        <Box width={14}>
          <Text>{truncate(row.targetAgent, 13)}</Text>
        </Box>
        <Box width={9}>
          <Text dimColor={row.outputReceivedAt === null}>
            {row.outputReceivedAt === null
              ? "waiting"
              : row.spawnOutcome ?? "?"}
          </Text>
        </Box>
        <Box width={7}>
          <Text>{String(row.nudgeCount)}</Text>
        </Box>
        <Box flexGrow={1}>
          <Text>{truncate(row.promptSummary, 60)}</Text>
        </Box>
      </Box>
      {expanded && (
        <Box flexDirection="column" marginLeft={2} marginTop={1} marginBottom={1}>
          <Text dimColor>id: {row.id}</Text>
          <Text dimColor>
            started: {formatTime(row.startedAt)}
            {row.outputReceivedAt !== null
              ? ` · output: ${formatTime(row.outputReceivedAt)}`
              : ""}
          </Text>
          {row.lastNudgeAt !== null && (
            <Text dimColor>
              last nudge: {formatTime(row.lastNudgeAt)} (count={row.nudgeCount})
            </Text>
          )}
          {row.controlCommandId !== null && row.controlCommandId !== undefined && (
            <Text dimColor>control_commands.id: {row.controlCommandId}</Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function statusColorFor(status: Delegation["status"]): string {
  switch (status) {
    case "open":
      return theme.fg.muted;
    case "awaiting":
    case "nudged":
      return theme.accent.warning;
    case "escalated":
      return theme.accent.danger;
    case "closed":
      return theme.accent.success;
    case "abandoned":
      return theme.fg.muted;
    default:
      return theme.fg.default;
  }
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

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
