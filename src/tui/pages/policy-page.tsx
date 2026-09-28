import { Box, Text } from "ink";
import { type JSX, useEffect, useState } from "react";
import type { policies } from "../../db/schema.js";
import { useDashboardServices } from "../dashboard-context.js";
import { formatTime, safe } from "../format.js";
import { roundBorder, theme } from "../theme.js";
import { EmptyState } from "../components/empty-state.js";
import { PageHeader } from "../components/typography.js";

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
  const { policy, policyPath, bus } = useDashboardServices();
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
        borderStyle={roundBorder()}
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
      borderStyle={roundBorder()}
      borderDimColor
      paddingX={1}
      flexGrow={1}
    >
      <PageHeader
        title="Policy"
        right={`${rows.length} rule${rows.length === 1 ? "" : "s"}`}
      />

      <Box flexDirection="column" marginTop={1}>
        {rows.length === 0 ? (
          <EmptyState
            title="No policy rules loaded"
            body={
              "Policy rules turn the ask/allow/deny decision into deterministic gates per (sourceAgent → target) tuple. " +
              (policyPath
                ? `Edit ${policyPath} and press [e] to reload.`
                : "Save a policy.yaml in $FOREMAN_HOME and press [e] to reload.")
            }
            commands={[
              "foreman init                       # writes a starter policy.yaml",
              "foreman policy show                # see what would match a call",
            ]}
            hotkeys={["[e] reload · [Esc] back"]}
          />
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
  // On the row itself (#657): "read_file ASK" next to "read_file ALLOW"
  // looked contradictory until you opened each rule.
  const when = conditionsSummary === "none" ? null : conditionsSummary;
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={selected ? theme.accent.primary : theme.fg.muted}>
          {selected ? "▸ " : "  "}
        </Text>
        <Text color={theme.accent.primary}>{row.sourceAgent}</Text>
        <Text color={theme.fg.muted}>{"  →  "}</Text>
        <Text bold={selected}>{row.target}</Text>{" "}
        <Text color={effectColor} bold>
          {row.effect.toUpperCase()}
        </Text>
        {when ? <Text color={theme.fg.default}>{` if ${when}`}</Text> : null}
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
          borderStyle={roundBorder()}
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

/** A rule's conditions in words, e.g. `path ~ /\.env$/, not path ~ /tmp/`.
 *  "none" when it has none. Exported for tests. */
export function describeConditions(conditions: string | null): string {
  if (!conditions) return "none";
  try {
    const c = JSON.parse(conditions) as {
      pathMatch?: string[];
      pathNotMatch?: string;
      commandMatch?: string[];
      toolPattern?: string;
      argContains?: string;
      rateLimits?: { messagesPerMinute?: number; tokensPerHour?: number };
    };
    const parts: string[] = [];
    if (c.pathMatch?.length) parts.push(`path ~ ${c.pathMatch.map((p) => `/${p}/`).join(" or ")}`);
    if (c.pathNotMatch) parts.push(`path !~ /${c.pathNotMatch}/`);
    if (c.commandMatch?.length) parts.push(`command has ${c.commandMatch.map((m) => JSON.stringify(m)).join(" or ")}`);
    if (c.toolPattern) parts.push(`tool ~ /${c.toolPattern}/`);
    if (c.argContains) parts.push(`args contain ${JSON.stringify(c.argContains)}`);
    if (c.rateLimits?.messagesPerMinute) parts.push(`over ${c.rateLimits.messagesPerMinute} calls/min`);
    if (c.rateLimits?.tokensPerHour) parts.push(`over ${c.rateLimits.tokensPerHour} tokens/h`);
    return parts.length > 0 ? safe(parts.join(", ")) : "none";
  } catch {
    return safe(conditions);
  }
}
