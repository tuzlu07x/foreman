import { Box, Text } from "ink";

export interface StatusBarProps {
  quitConfirm?: boolean;
}

export function StatusBar({ quitConfirm }: StatusBarProps): JSX.Element {
  if (quitConfirm) {
    return (
      <Box paddingX={1}>
        <Text color="#FFC542">Quit? [y/n]</Text>
      </Box>
    );
  }
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text dimColor>[?] help · [q] quit</Text>
      <Text dimColor>🦫 v0.1.0-pre</Text>
    </Box>
  );
}
