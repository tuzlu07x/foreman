import { Box, Text } from "ink";

export interface StatsPanelProps {
  width?: string;
}

export function StatsPanel({ width }: StatsPanelProps): JSX.Element {
  return (
    <Box
      width={width}
      flexDirection="column"
      borderStyle="single"
      borderDimColor
      paddingX={1}
    >
      <Text color="#FF8C42">Stats</Text>
      <Text dimColor>placeholder</Text>
    </Box>
  );
}
