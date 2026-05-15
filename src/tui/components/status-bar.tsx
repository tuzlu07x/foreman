import { Box, Text } from "ink";
import { useLayout } from "../hooks.js";
import { type Layout } from "../layout.js";
import { theme } from "../theme.js";

export interface StatusBarProps {
  quitConfirm?: boolean;
  version?: string;
}

// Each row of hint text the status bar should render for a given layout.
// Wide gets the chatty single-line form; medium drops the labels for
// single-letter hotkeys; narrow splits into two lines and drops the version
// badge entirely.
export interface StatusBarLayout {
  rows: string[];
  showVersion: boolean;
}

export function buildStatusBarLayout(layout: Layout): StatusBarLayout {
  if (layout === "wide") {
    return {
      rows: [
        "[h] help · [a] agents · [v] providers · [c] chat · [g] settings · [k] keys · [l] logs · [p] policy · [s] sessions · [q] quit",
      ],
      showVersion: true,
    };
  }
  if (layout === "medium") {
    return {
      rows: ["[h] [a] [v] [c] [g] [k] [l] [p] [s] [q]"],
      showVersion: true,
    };
  }
  return {
    rows: ["nav:    [h] [a] [v] [c] [g] [k] [l] [p] [s]", "system: [q]"],
    showVersion: false,
  };
}

export function StatusBar({
  quitConfirm,
  version = "0.1.0",
}: StatusBarProps): JSX.Element {
  const layout = useLayout();
  if (quitConfirm) {
    return (
      <Box paddingX={1}>
        <Text color={theme.accent.warning}>Quit? [y/n]</Text>
      </Box>
    );
  }
  const { rows, showVersion } = buildStatusBarLayout(layout);
  if (rows.length === 1) {
    return (
      <Box paddingX={1} justifyContent="space-between">
        <Text color={theme.fg.muted}>{rows[0]}</Text>
        {showVersion && (
          <Text color={theme.fg.muted}>🦫 v{version}</Text>
        )}
      </Box>
    );
  }
  return (
    <Box paddingX={1} flexDirection="column">
      {rows.map((row, i) => (
        <Text key={i} color={theme.fg.muted}>
          {row}
        </Text>
      ))}
    </Box>
  );
}
