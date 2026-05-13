import { Box, Text } from "ink";
import { useEffect, useMemo, useState } from "react";
import { theme } from "../theme.js";
import {
  blockFallbackFrame,
  buildMorphFrame,
  MORPH_GLYPHS,
  pickChafaBlinkAsset,
  pickChafaSize,
  type MascotFrame,
} from "./mascot-frames.js";
import {
  detectChafa,
  renderChafaPng,
  resolveMascotAsset,
} from "./mascot-renderer.js";

const MORPH_STEP_MS = 90;
const BLINK_INTERVAL_MS = 4800;
const BLINK_HOLD_MS = 140;

export interface ResolvedFrames {
  normal: MascotFrame;
  blink: MascotFrame;
  source: "chafa" | "block";
}

export interface BootMascotProps {
  termCols: number;
  enabled: boolean;
  onMorphComplete?: () => void;
}

export function resolveFrames(termCols: number): ResolvedFrames {
  if (detectChafa()) {
    const { cols, rows, asset } = pickChafaSize(termCols);
    const path = resolveMascotAsset(asset);
    if (path) {
      const rendered = renderChafaPng(path, cols, rows);
      if (rendered) {
        const blinkAsset = pickChafaBlinkAsset(termCols);
        const blinkPath = blinkAsset ? resolveMascotAsset(blinkAsset) : null;
        const blinkRendered = blinkPath
          ? renderChafaPng(blinkPath, cols, rows)
          : null;
        return {
          normal: { lines: rendered, width: cols, height: rendered.length },
          blink: blinkRendered
            ? {
                lines: blinkRendered,
                width: cols,
                height: blinkRendered.length,
              }
            : { lines: rendered, width: cols, height: rendered.length },
          source: "chafa",
        };
      }
    }
  }
  return {
    normal: blockFallbackFrame(false),
    blink: blockFallbackFrame(true),
    source: "block",
  };
}

export function BootMascot({
  termCols,
  enabled,
  onMorphComplete,
}: BootMascotProps): JSX.Element {
  const frames = useMemo(() => resolveFrames(termCols), [termCols]);
  const morphTarget = useMemo(() => blockFallbackFrame(false).lines, []);
  const [morphIdx, setMorphIdx] = useState<number>(
    enabled ? 0 : MORPH_GLYPHS.length,
  );
  const [blinking, setBlinking] = useState(false);

  useEffect(() => {
    if (!enabled) {
      onMorphComplete?.();
      return;
    }
    if (morphIdx >= MORPH_GLYPHS.length) {
      onMorphComplete?.();
      return;
    }
    const t = setTimeout(() => setMorphIdx((m) => m + 1), MORPH_STEP_MS);
    return () => clearTimeout(t);
  }, [morphIdx, enabled, onMorphComplete]);

  useEffect(() => {
    if (!enabled) return;
    if (morphIdx < MORPH_GLYPHS.length) return;
    let release: ReturnType<typeof setTimeout> | null = null;
    const cycle = setInterval(() => {
      setBlinking(true);
      release = setTimeout(() => {
        setBlinking(false);
        release = null;
      }, BLINK_HOLD_MS);
    }, BLINK_INTERVAL_MS);
    return () => {
      clearInterval(cycle);
      if (release) clearTimeout(release);
    };
  }, [enabled, morphIdx]);

  const morphing = morphIdx < MORPH_GLYPHS.length;
  const lines = morphing
    ? buildMorphFrame(morphTarget, morphIdx)
    : blinking
      ? frames.blink.lines
      : frames.normal.lines;

  const color = morphing ? theme.accent.primary : undefined;

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} color={color}>
          {line}
        </Text>
      ))}
    </Box>
  );
}
