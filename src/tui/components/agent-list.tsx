import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { RegisteredAgent } from "../../core/registry.js";
import { theme } from "../theme.js";
import { useDashboardState } from "../use-dashboard-state.js";

export interface AgentListProps {
  width?: string;
  compact?: boolean;
}

export function AgentList({ width, compact }: AgentListProps): JSX.Element {
  const { agents, perAgentToday } = useDashboardState();
  const blinkOn = useBlink(1000);

  if (compact) {
    return (
      <Box borderStyle="single" borderDimColor paddingX={1}>
        <Text color={theme.accent.primary}>Agents </Text>
        {agents.length === 0 ? (
          <Text color={theme.fg.muted}>(none registered)</Text>
        ) : (
          agents.map((agent, i) => (
            <Text key={agent.id}>
              {i > 0 ? "   " : ""}
              <Dot active={agent.status === "active"} blinkOn={blinkOn} />{" "}
              {agent.id}{" "}
              <Text color={theme.fg.muted}>
                ({perAgentToday[agent.id] ?? 0})
              </Text>
            </Text>
          ))
        )}
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
    >
      <Text color={theme.accent.primary}>Agents</Text>
      {agents.length === 0 ? (
        <Text color={theme.fg.muted}>(none registered)</Text>
      ) : (
        agents.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            count={perAgentToday[agent.id] ?? 0}
            blinkOn={blinkOn}
          />
        ))
      )}
    </Box>
  );
}

interface AgentRowProps {
  agent: RegisteredAgent;
  count: number;
  blinkOn: boolean;
}

function AgentRow({ agent, count, blinkOn }: AgentRowProps): JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text>
        <Dot active={agent.status === "active"} blinkOn={blinkOn} /> {agent.id}
      </Text>
      <Text color={theme.fg.muted}>
        {"  "}
        {agent.status} · {count} req
      </Text>
    </Box>
  );
}

function Dot({
  active,
  blinkOn,
}: {
  active: boolean;
  blinkOn: boolean;
}): JSX.Element {
  if (active) {
    return (
      <Text color={blinkOn ? theme.accent.success : theme.fg.muted}>
        {theme.symbols.activeDot}
      </Text>
    );
  }
  return <Text color={theme.fg.muted}>{theme.symbols.idleDot}</Text>;
}

function useBlink(periodMs: number): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setOn((v) => !v), periodMs);
    return () => clearInterval(t);
  }, [periodMs]);
  return on;
}
