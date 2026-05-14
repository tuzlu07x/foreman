import { Box, Text, useStdout } from "ink";
import { useCallback, useEffect, useState } from "react";
import { buildBootLines, type BootInfo } from "../boot-info.js";
import { theme } from "../theme.js";
import { BootMascot } from "./boot-mascot.js";
import { Wordmark } from "./wordmark.js";

const CHECK_STAGGER_MS = 80;

type BootPhase = "morph" | "wordmark" | "checks" | "idle";

export interface AgentUpdateNotice {
  id: string;
  displayName: string;
  current: string;
  latest: string;
}

export interface AgentOvershootNotice {
  id: string;
  displayName: string;
  installed: string;
  supportedRange: string;
}

export interface BootBannerProps {
  info: BootInfo;
  animationsEnabled?: boolean;
  /** When set, renders a one-line "Update available" notice under the checks. */
  updateNotice?: { current: string; latest: string } | null;
  /** Per-agent npm update offers (#75). */
  agentUpdates?: AgentUpdateNotice[];
  /** Per-agent supported_versions overshoot warnings (#75). */
  agentOvershoots?: AgentOvershootNotice[];
}

export function BootBanner({
  info,
  animationsEnabled = true,
  updateNotice = null,
  agentUpdates = [],
  agentOvershoots = [],
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
        {updateNotice && visibleChecks >= lines.length ? (
          <Text>
            <Text color={theme.accent.warning}>{theme.symbols.bullet}</Text>{" "}
            <Text color={theme.accent.warning}>
              Update available: {updateNotice.latest}
            </Text>{" "}
            <Text color={theme.fg.muted}>
              (run: npm install -g foreman-agent@latest)
            </Text>
          </Text>
        ) : null}
        {agentUpdates.length > 0 && visibleChecks >= lines.length ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.accent.warning}>
              {theme.symbols.bullet} Agent updates available:
            </Text>
            {agentUpdates.map((u) => (
              <Text key={u.id}>
                {"   "}
                <Text color={theme.fg.emphasis}>{padRight(u.id, 14)}</Text>{" "}
                <Text color={theme.fg.muted}>v{u.current} → </Text>
                <Text color={theme.accent.success}>v{u.latest}</Text>
              </Text>
            ))}
            <Text color={theme.fg.muted}>
              {"   Run: foreman agent update [name|all]"}
            </Text>
          </Box>
        ) : null}
        {agentOvershoots.length > 0 && visibleChecks >= lines.length ? (
          <Box flexDirection="column" marginTop={1}>
            {agentOvershoots.map((w) => (
              <Box flexDirection="column" key={w.id}>
                <Text color={theme.accent.warning}>
                  {theme.symbols.bullet} {w.id} v{w.installed} is newer than
                  Foreman's tested range ({w.supportedRange}).
                </Text>
                <Text color={theme.fg.muted}>
                  {"   Foreman may still work, but new flows aren't verified."}
                </Text>
              </Box>
            ))}
          </Box>
        ) : null}
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

function padRight(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}
