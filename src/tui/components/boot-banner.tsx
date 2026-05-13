import { Box, Text, useStdout } from "ink";
import { useCallback, useEffect, useState } from "react";
import { buildBootLines, type BootInfo } from "../boot-info.js";
import { theme } from "../theme.js";
import { BootMascot } from "./boot-mascot.js";
import { Wordmark } from "./wordmark.js";

const CHECK_STAGGER_MS = 80;

type BootPhase = "morph" | "wordmark" | "checks" | "idle";

export interface BootBannerProps {
  info: BootInfo;
  animationsEnabled?: boolean;
}

export function BootBanner({
  info,
  animationsEnabled = true,
}: BootBannerProps): JSX.Element {
  const lines = buildBootLines(info);
  const { stdout } = useStdout();
  const termCols = stdout?.columns ?? 80;

  const [phase, setPhase] = useState<BootPhase>(
    animationsEnabled ? "morph" : "idle",
  );
  const [visibleChecks, setVisibleChecks] = useState<number>(
    animationsEnabled ? 0 : lines.length,
  );

  const handleMorphComplete = useCallback(() => {
    setPhase((p) => (p === "morph" ? "wordmark" : p));
  }, []);

  const handleWordmarkComplete = useCallback(() => {
    setPhase((p) => (p === "wordmark" ? "checks" : p));
  }, []);

  useEffect(() => {
    if (phase !== "checks") return;
    if (visibleChecks >= lines.length) {
      setPhase("idle");
      return;
    }
    const t = setTimeout(
      () => setVisibleChecks((v) => v + 1),
      CHECK_STAGGER_MS,
    );
    return () => clearTimeout(t);
  }, [phase, visibleChecks, lines.length]);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={2}>
        <BootMascot
          termCols={termCols}
          enabled={animationsEnabled}
          onMorphComplete={handleMorphComplete}
        />
        <Box flexDirection="column" justifyContent="center">
          <Wordmark
            text="FOREMAN"
            enabled={animationsEnabled && phase !== "morph"}
            onComplete={handleWordmarkComplete}
          />
          <Text color={theme.fg.muted}>
            your agent guardian · v{info.version}
          </Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {lines.slice(0, visibleChecks).map((line, i) => (
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
