import { Box, Text } from "ink";
import type { Request } from "../../db/schema.js";
import {
  formatDuration,
  formatTime,
  statusIconFor,
  summariseTool,
  targetLabel,
} from "../format.js";
import { theme } from "../theme.js";
import { useDashboardState } from "../use-dashboard-state.js";

export interface ActivityFeedProps {
  width?: string;
  minimal?: boolean;
}

export function ActivityFeed({
  width,
  minimal,
}: ActivityFeedProps): JSX.Element {
  const { recentRequests } = useDashboardState();
  const visible = minimal
    ? recentRequests.slice(0, 5)
    : recentRequests.slice(0, 20);

  const inner = (
    <Box flexDirection="column">
      {visible.length === 0 ? (
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
      borderStyle="single"
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
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text>
        <Text color={theme.fg.muted}>[{formatTime(request.createdAt)}]</Text>{" "}
        <Text color={theme.accent.primary}>
          {targetLabel(request.sourceAgent, request.targetAgent)}
        </Text>{" "}
        <Text bold>{summariseTool(request.targetTool, request.args)}</Text>
      </Text>
      <Text>
        {"  "}
        <Text color={toneColor}>{status.icon}</Text>{" "}
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
