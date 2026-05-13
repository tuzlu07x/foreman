import { Box, Text } from "ink";

export interface ActivityFeedProps {
  width?: string;
  minimal?: boolean;
}

export function ActivityFeed({
  width,
  minimal,
}: ActivityFeedProps): JSX.Element {
  if (minimal) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>Activity (placeholder)</Text>
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
      flexGrow={1}
    >
      <Text color="#FF8C42">Activity</Text>
      <Text dimColor>placeholder</Text>
    </Box>
  );
}
