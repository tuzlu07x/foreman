import { Box, Text } from "ink";
import type { JSX } from "react";
import { theme } from "../theme.js";

/** A destructive page action waiting for y/N (#657): deleting a secret,
 *  removing an agent, regenerating its key. */
export interface PendingConfirm {
  question: string;
  /** What `y` does, e.g. "delete". */
  yesLabel: string;
  run: () => void;
}

/** Takes the status bar's place while a y/N question is open. Only `y`
 *  confirms; any other key cancels. */
export function ConfirmBar({ confirm }: { confirm: Pick<PendingConfirm, "question" | "yesLabel"> }): JSX.Element {
  return (
    <Box paddingX={1} flexDirection="column">
      <Text color={theme.accent.warning} bold wrap="wrap">
        {`${theme.symbols.warn} ${confirm.question}`}
      </Text>
      <Text>
        <Text color={theme.fg.emphasis} bold>
          y
        </Text>
        <Text color={theme.fg.muted}>{` ${confirm.yesLabel}  ·  `}</Text>
        <Text color={theme.fg.emphasis} bold>
          n
        </Text>
        <Text color={theme.fg.muted}> / any other key: cancel</Text>
      </Text>
    </Box>
  );
}
