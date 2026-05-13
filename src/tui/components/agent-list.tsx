import { Box, Text } from "ink";

export interface AgentListProps {
  width?: string;
  compact?: boolean;
}

export function AgentList({ width, compact }: AgentListProps): JSX.Element {
  if (compact) {
    return (
      <Box borderStyle="single" borderDimColor paddingX={1}>
        <Text dimColor>Agents (placeholder)</Text>
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
      <Text color="#FF8C42">Agents</Text>
      <Text dimColor>placeholder</Text>
    </Box>
  );
}
