import { Box, Text } from "ink";
import { percentBar, percentLabel } from "../format.js";
import { theme } from "../theme.js";
import { useDashboardState } from "../use-dashboard-state.js";

export interface StatsPanelProps {
  width?: string;
}

export function StatsPanel({ width }: StatsPanelProps): JSX.Element {
  const { todayStats, activeSessions } = useDashboardState();
  return (
    <Box
      width={width}
      flexDirection="column"
      borderStyle="single"
      borderDimColor
      paddingX={1}
    >
      <Text color={theme.accent.primary}>Today</Text>
      <Text>
        Requests <Text bold>{todayStats.total}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Bar
          label="Allowed"
          tone={theme.accent.success}
          value={todayStats.allowed}
          total={todayStats.total}
        />
        <Bar
          label="Denied"
          tone={theme.accent.danger}
          value={todayStats.denied}
          total={todayStats.total}
        />
        <Bar
          label="Pending"
          tone={theme.accent.warning}
          value={todayStats.pending}
          total={todayStats.total}
        />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.accent.primary}>Sessions</Text>
        <Text>
          <Text bold>{activeSessions}</Text>{" "}
          <Text color={theme.fg.muted}>active</Text>
        </Text>
      </Box>
    </Box>
  );
}

interface BarProps {
  label: string;
  tone: string;
  value: number;
  total: number;
}

function Bar({ label, tone, value, total }: BarProps): JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color={theme.fg.muted}>{label}</Text>
      <Text>
        <Text color={tone}>{percentBar(value, total, 10)}</Text>{" "}
        <Text color={theme.fg.muted}>{percentLabel(value, total)}</Text>
      </Text>
    </Box>
  );
}
