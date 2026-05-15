import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { RegisteredAgent } from "../../core/registry.js";
import { useDashboardServices } from "../dashboard-context.js";
import { formatTime } from "../format.js";
import { singleBorder, theme } from "../theme.js";

export interface AgentsPageProps {
  selectedIdx: number;
  expanded: boolean;
  notice: string | null;
}

export function AgentsPage({
  selectedIdx,
  expanded,
  notice,
}: AgentsPageProps): JSX.Element {
  const { registry, bus } = useDashboardServices();
  const [rows, setRows] = useState<RegisteredAgent[]>(() => registry.listAll());

  useEffect(() => {
    const refresh = (): void => setRows(registry.listAll());
    const offRegistered = bus.on("agent:registered", refresh);
    const offRemoved = bus.on("agent:removed", refresh);
    const offHeartbeat = bus.on("agent:heartbeat", refresh);
    const offRotated = bus.on("agent:key-rotated", refresh);
    const interval = setInterval(refresh, 2000);
    return () => {
      offRegistered();
      offRemoved();
      offHeartbeat();
      offRotated();
      clearInterval(interval);
    };
  }, [registry, bus]);

  const safeSelected = Math.max(0, Math.min(selectedIdx, rows.length - 1));

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
          Agents
        </Text>
        <Text color={theme.fg.muted}>
          {rows.length} registered ·{" "}
          {rows.filter((r) => r.status === "active").length} active ·{" "}
          {rows.filter((r) => r.status === "blocked").length} blocked
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {rows.length === 0 ? (
          <Text color={theme.fg.muted}>
            (no agents registered — run 'foreman setup' to add one)
          </Text>
        ) : (
          rows.map((agent, i) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              selected={i === safeSelected}
              expanded={expanded && i === safeSelected}
            />
          ))
        )}
      </Box>

      {notice && (
        <Box marginTop={1}>
          <Text color={theme.accent.success}>{notice}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.fg.muted}>{"─".repeat(60)}</Text>
      </Box>
      <Text color={theme.fg.muted}>
        [↑↓] move · [Enter] expand · [b] block/unblock · [r] regen-key ·
        [d] remove · [Esc] back
      </Text>
    </Box>
  );
}

function AgentRow({
  agent,
  selected,
  expanded,
}: {
  agent: RegisteredAgent;
  selected: boolean;
  expanded: boolean;
}): JSX.Element {
  const isActive = agent.status === "active";
  const isBlocked = agent.status === "blocked";
  const dotColor = isBlocked
    ? theme.accent.danger
    : isActive
      ? theme.accent.success
      : theme.fg.muted;
  const dot = isActive ? theme.symbols.activeDot : theme.symbols.idleDot;
  const registryId =
    typeof agent.metadata?.registryId === "string"
      ? agent.metadata.registryId
      : agent.id;
  const lastSeen = agent.lastSeenAt
    ? formatTime(agent.lastSeenAt)
    : "never";
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={selected ? theme.accent.primary : theme.fg.muted}>
          {selected ? "▸ " : "  "}
        </Text>
        <Text color={dotColor}>{dot}</Text>{" "}
        <Text color={theme.accent.primary}>{agent.id}</Text>{" "}
        <Text color={theme.fg.muted}>
          ({agent.displayName}) · {agent.transport}
          {isBlocked ? " · blocked" : ""}
          {" · last "}
          {lastSeen}
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
          <Text color={theme.fg.muted}>registry id: {registryId}</Text>
          <Text color={theme.fg.muted}>status: {agent.status}</Text>
          <Text color={theme.fg.muted}>
            registered at: {formatTime(agent.registeredAt)}
          </Text>
          {typeof agent.metadata?.registryHomepage === "string" && (
            <Text color={theme.fg.muted}>
              homepage: {agent.metadata.registryHomepage}
            </Text>
          )}
          <Text color={theme.fg.muted}>
            mcp source key: --source {agent.id}
          </Text>
        </Box>
      )}
    </Box>
  );
}
