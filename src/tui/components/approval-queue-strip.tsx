import { Box, Text } from "ink";
import type { JSX } from "react";
import { secondsLeft, selectedIndex, type ApprovalQueueState } from "../approval-queue.js";
import { safe } from "../format.js";
import { riskColor, theme } from "../theme.js";

/** "Approval 2 of 3" above the modal, with the other waiting calls and
 *  their countdowns, so nothing times out unseen (#614). */
export function ApprovalQueueStrip({
  state,
  now,
}: {
  state: ApprovalQueueState;
  now: number;
}): JSX.Element | null {
  if (state.items.length < 2) return null;
  const index = selectedIndex(state);
  return (
    <Box paddingX={1} flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={theme.accent.warning} bold>
          {`Approval ${index + 1} of ${state.items.length}`}
        </Text>
        <Text color={theme.fg.muted}>{"   "}</Text>
        <Text color={theme.fg.emphasis} bold>
          ←→
        </Text>
        <Text color={theme.fg.muted}> switch   </Text>
        {state.items.map((item, i) => {
          const r = item.request;
          const active = i === index;
          return (
            <Text key={r.requestId}>
              <Text color={active ? theme.accent.primary : theme.fg.muted}>{active ? "▎" : " "}</Text>
              <Text color={riskColor(r.riskBucket)}>{theme.symbols.activeDot}</Text>
              <Text color={active ? theme.fg.emphasis : theme.fg.muted}>
                {` ${safe(r.sourceAgent)}→${safe(r.targetTool ?? r.targetAgent ?? "?")} ${secondsLeft(item, now)}s  `}
              </Text>
            </Text>
          );
        })}
      </Text>
    </Box>
  );
}
