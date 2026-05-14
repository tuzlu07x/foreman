import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { policies } from "../../db/schema.js";
import { useDashboardServices } from "../dashboard-context.js";
import { formatTime } from "../format.js";
import { singleBorder, theme } from "../theme.js";

export type PolicyRow = typeof policies.$inferSelect;

export interface PolicyPageProps {
  selectedIdx: number;
  expanded: boolean;
  notice: string | null;
}

const VISIBLE_ROWS = 10;

export function PolicyPage({
  selectedIdx,
  expanded,
  notice,
}: PolicyPageProps): JSX.Element {
  const { policy, bus } = useDashboardServices();
  const [rows, setRows] = useState<PolicyRow[]>(() =>
    policy ? policy.list() : [],
  );

  useEffect(() => {
    if (!policy) return;
    const refresh = (): void => setRows(policy.list());
    return bus.on("policy:changed", refresh);
  }, [policy, bus]);

  if (!policy) {
    return (
      <Box
        flexDirection="column"
        borderStyle={singleBorder()}
        borderDimColor
        paddingX={1}
        flexGrow={1}
      >
        <Text color={theme.accent.danger}>PolicyEngine not wired into App</Text>
      </Box>
    );
  }

  const safeSelected = Math.max(0, Math.min(selectedIdx, rows.length - 1));
  const offsetStart = Math.max(
    0,
    Math.min(
      rows.length - VISIBLE_ROWS,
      safeSelected - Math.floor(VISIBLE_ROWS / 2),
    ),
  );
  const visible = rows.slice(offsetStart, offsetStart + VISIBLE_ROWS);

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
          Policy
        </Text>
        <Text color={theme.fg.muted}>
          {rows.length} rule{rows.length === 1 ? "" : "s"}
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {rows.length === 0 ? (
          <Text color={theme.fg.muted}>
            (no rules — edit ~/.foreman/policy.yaml then press e to reload)
          </Text>
        ) : (
          visible.map((row, i) => {
            const absoluteIdx = offsetStart + i;
            const isSelected = absoluteIdx === safeSelected;
            return (
              <RuleRow
                key={row.id}
                row={row}
                selected={isSelected}
                expanded={expanded && isSelected}
              />
            );
          })
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
        [↑↓] move · [Enter] detail · [d] disable/enable · [e] edit yaml · [Esc]
        back
      </Text>
    </Box>
  );
}

function RuleRow({
  row,
  selected,
  expanded,
}: {
  row: PolicyRow;
  selected: boolean;
  expanded: boolean;
}): JSX.Element {
  const effectColor = effectTone(row.effect);
  const enabled = row.enabled === 1;
  const conditionsSummary = describeConditions(row.conditions);
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={selected ? theme.accent.primary : theme.fg.muted}>
          {selected ? "▸ " : "  "}
        </Text>
        <Text color={theme.accent.primary}>{row.sourceAgent}</Text>
        <Text color={theme.fg.muted}>{"  →  "}</Text>
        <Text bold={selected}>{row.target}</Text>{" "}
        <Text color={effectColor} bold>
          {row.effect.toUpperCase()}
        </Text>
        {!enabled && <Text color={theme.fg.muted}> · DISABLED</Text>}
        <Text color={theme.fg.muted}>
          {" · "}
          {row.createdBy} · {formatTime(row.createdAt)}
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
          <Text color={theme.fg.muted}>rule id: {row.id}</Text>
          <Text color={theme.fg.muted}>conditions: {conditionsSummary}</Text>
        </Box>
      )}
    </Box>
  );
}

function effectTone(effect: "allow" | "deny" | "ask"): string {
  if (effect === "allow") return theme.accent.success;
  if (effect === "deny") return theme.accent.danger;
  return theme.accent.warning;
}

function describeConditions(conditions: string | null): string {
  if (!conditions) return "none";
  try {
    const parsed = JSON.parse(conditions) as {
      pathNotMatch?: string;
      rateLimits?: { messagesPerMinute?: number; tokensPerHour?: number };
    };
    const parts: string[] = [];
    if (parsed.pathNotMatch)
      parts.push(`pathNotMatch=/${parsed.pathNotMatch}/`);
    if (parsed.rateLimits?.messagesPerMinute) {
      parts.push(`mpm=${parsed.rateLimits.messagesPerMinute}`);
    }
    if (parsed.rateLimits?.tokensPerHour) {
      parts.push(`tph=${parsed.rateLimits.tokensPerHour}`);
    }
    return parts.length > 0 ? parts.join(", ") : "none";
  } catch {
    return conditions;
  }
}
