import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useEffect, useState } from "react";
import type { Request } from "../../db/schema.js";
import {
  formatDuration,
  relativeTime,
  statusIconFor,
  summariseTool,
  targetLabel,
} from "../format.js";
import { singleBorder, theme } from "../theme.js";
import { useDashboardState } from "../use-dashboard-state.js";

const FADE_DURATION_MS = 200;

export interface ActivityFeedProps {
  width?: string;
  minimal?: boolean;
}

export function ActivityFeed({
  width,
  minimal,
}: ActivityFeedProps): JSX.Element {
  const { recentRequests, pendingRequests } = useDashboardState();
  const visible = minimal
    ? recentRequests.slice(0, 5)
    : recentRequests.slice(0, 20);

  const inner = (
    <Box flexDirection="column">
      {pendingRequests.map((p) => (
        <PendingRow key={p.requestId} pending={p} />
      ))}
      {visible.length === 0 && pendingRequests.length === 0 ? (
        <Text color={theme.fg.muted}>(no activity yet)</Text>
      ) : (
        visible.map((req) => <ActivityRow key={req.id} request={req} />)
      )}
    </Box>
  );

  if (minimal) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.accent.primary}>Activity</Text>
        {inner}
      </Box>
    );
  }

  return (
    <Box
      width={width}
      flexDirection="column"
      borderStyle={singleBorder()}
      borderDimColor
      paddingX={1}
      flexGrow={1}
    >
      <Text color={theme.accent.primary}>Activity</Text>
      {inner}
    </Box>
  );
}

function ActivityRow({ request }: { request: Request }): JSX.Element {
  const status = statusIconFor(request.decision);
  const toneColor =
    status.tone === "success"
      ? theme.accent.success
      : status.tone === "danger"
        ? theme.accent.danger
        : theme.accent.warning;
  // 200ms fade-in: first render shows the row in muted fg, then it
  // promotes to the default fg once the timer fires (TUI spec §8.1).
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setFaded(true), FADE_DURATION_MS);
    return () => clearTimeout(t);
  }, []);
  const headerColor = faded ? theme.fg.default : theme.fg.muted;
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text color={headerColor}>
        <Text color={theme.fg.muted}>{relativeTime(request.createdAt)}</Text>
        <Text color={theme.fg.muted}> · </Text>
        <Text color={faded ? theme.accent.primary : theme.fg.muted}>
          {targetLabel(request.sourceAgent, request.targetAgent)}
        </Text>{" "}
        <Text bold={faded}>
          {summariseTool(request.targetTool, request.args)}
        </Text>
      </Text>
      <Text>
        {"  "}
        <Text color={faded ? toneColor : theme.fg.muted}>{status.icon}</Text>{" "}
        <Text color={theme.fg.muted}>
          {request.decision} · {request.decidedBy ?? "pending"}
          {request.durationMs !== null
            ? ` · ${formatDuration(request.durationMs)}`
            : ""}
        </Text>
      </Text>
    </Box>
  );
}

function PendingRow({
  pending,
}: {
  pending: { requestId: string; sourceAgent: string; targetTool?: string };
}): JSX.Element {
  return (
    <Box flexDirection="row" gap={1}>
      <Spinner />
      <Text color={theme.accent.info}>
        {pending.sourceAgent}
        {pending.targetTool ? ` → ${pending.targetTool}` : ""}{" "}
        <Text color={theme.fg.muted}>…</Text>
      </Text>
    </Box>
  );
}
