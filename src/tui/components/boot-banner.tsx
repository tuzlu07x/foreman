import { Box, Text } from "ink";

export function BootBanner(): JSX.Element {
  return (
    <Box flexDirection="row" gap={2}>
      <Text color="#FF8C42">Foreman</Text>
      <Text dimColor>v0.1.0-pre · your agent guardian</Text>
    </Box>
  );
}
