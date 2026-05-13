import { Box, Text } from "ink";
import BigText from "ink-big-text";
import Gradient from "ink-gradient";
import { useEffect, useState } from "react";
import { buildBootLines, type BootInfo } from "../boot-info.js";
import { isAsciiMode, theme } from "../theme.js";

interface MascotLine {
  text: string;
  color?: string;
}

const MASCOT: MascotLine[] = [
  { text: "   ___[F]___", color: theme.accent.primary },
  { text: "  /         \\" },
  { text: " |__/ o   o \\__|" },
  { text: "    |  \\_/  |" },
  { text: "   /|_______|\\" },
  { text: "  / |==VEST=| \\", color: theme.accent.primary },
  { text: " /__|=======|__\\", color: theme.accent.primary },
  { text: "    |_______|" },
];

const STAGGER_MS = 80;

export interface BootBannerProps {
  info: BootInfo;
}

export function BootBanner({ info }: BootBannerProps): JSX.Element {
  const lines = buildBootLines(info);
  const [visible, setVisible] = useState(0);

  useEffect(() => {
    if (visible >= lines.length) return;
    const t = setTimeout(() => setVisible((v) => v + 1), STAGGER_MS);
    return () => clearTimeout(t);
  }, [visible, lines.length]);

  const ascii = isAsciiMode();

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={2}>
        <Box flexDirection="column">
          {MASCOT.map((line, i) => (
            <Text key={i} color={line.color}>
              {line.text}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" justifyContent="center">
          {ascii ? (
            <Text bold color={theme.accent.primary}>
              FOREMAN
            </Text>
          ) : (
            <Gradient colors={[theme.accent.primary, theme.accent.primaryAlt]}>
              <BigText text="FOREMAN" font="block" />
            </Gradient>
          )}
          <Text color={theme.fg.muted}>
            your agent guardian · v{info.version}
          </Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {lines.slice(0, visible).map((line, i) => (
          <Text key={i}>
            <Text color={theme.accent.primary}>{theme.symbols.bullet}</Text>{" "}
            {line.label}
            {" ".repeat(Math.max(1, 18 - line.label.length))}
            <Text color={theme.fg.muted}>{line.detail}</Text>
          </Text>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.fg.muted}>{"─".repeat(60)}</Text>
      </Box>
      <Box>
        <Text color={theme.fg.muted}>Press ? for help · q to quit</Text>
      </Box>
    </Box>
  );
}
