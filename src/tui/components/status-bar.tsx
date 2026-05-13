import { Box, Text } from "ink";
import { theme } from "../theme.js";

export interface StatusBarProps {
  quitConfirm?: boolean;
  version?: string;
}

export function StatusBar({
  quitConfirm,
  version = "0.1.0-pre",
}: StatusBarProps): JSX.Element {
  if (quitConfirm) {
    return (
      <Box paddingX={1}>
        <Text color={theme.accent.warning}>Quit? [y/n]</Text>
      </Box>
    );
  }
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text color={theme.fg.muted}>
        [?] help · [l] logs · [p] policy · [s] sessions · [a] agents · [q] quit
      </Text>
      <Text color={theme.fg.muted}>🦫 v{version}</Text>
    </Box>
  );
}
