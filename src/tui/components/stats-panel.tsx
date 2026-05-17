import { Box, Text } from "ink";
import { percentBar, percentLabel } from "../format.js";
import { singleBorder, theme } from "../theme.js";
import { useDashboardState } from "../use-dashboard-state.js";
import { PageHeader } from "./typography.js";

// =============================================================================
// Dashboard stats tile (#234 UX-10)
// =============================================================================
//
// Two-section card: today's request stats up top (big colored numbers + per-
// outcome bars), session count below. The big numbers + per-status colour
// give the user "is anything broken?" at a glance without reading labels.

export interface StatsPanelProps {
  width?: string;
}

export function StatsPanel({ width }: StatsPanelProps): JSX.Element {
  const { todayStats, activeSessions } = useDashboardState();
  return (
    <Box
      width={width}
      flexDirection="column"
      borderStyle={singleBorder()}
      borderDimColor
      paddingX={1}
    >
      <PageHeader title="Today" right={`${todayStats.total} requests`} noDivider />

      <Box flexDirection="row" marginTop={1}>
        <BigStat
          label="allowed"
          value={todayStats.allowed}
          color={theme.accent.success}
        />
        <Box width={2} />
        <BigStat
          label="denied"
          value={todayStats.denied}
          color={theme.accent.danger}
        />
        <Box width={2} />
        <BigStat
          label="ask"
          value={todayStats.pending}
          color={theme.accent.warning}
        />
      </Box>

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
          <Text bold color={theme.fg.emphasis}>
            {activeSessions}
          </Text>{" "}
          <Text color={theme.fg.muted}>active</Text>
        </Text>
      </Box>
    </Box>
  );
}

interface BigStatProps {
  label: string;
  value: number;
  color: string;
}

function BigStat({ label, value, color }: BigStatProps): JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold color={color}>
        {value.toString()}
      </Text>
      <Text color={theme.fg.muted}>{label}</Text>
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
