import { type JSX, useEffect, useState } from "react";
import { MASCOT_HEIGHT } from "./mascot-frames.js";
import { PixelMascot } from "./pixel-mascot.js";

// Boot: the mascot draws itself row by row, top to bottom, then blinks now
// and then. Without animations it is shown at once and never blinks.

const REVEAL_STEP_MS = 60;
const BLINK_INTERVAL_MS = 4800;
const BLINK_HOLD_MS = 140;

export interface BootMascotProps {
  enabled: boolean;
  /** Called once the mascot is fully drawn. */
  onMorphComplete?: () => void;
}

export function BootMascot({ enabled, onMorphComplete }: BootMascotProps): JSX.Element | null {
  const [rows, setRows] = useState<number>(enabled ? 0 : MASCOT_HEIGHT);
  const [blinking, setBlinking] = useState(false);

  useEffect(() => {
    if (!enabled || rows >= MASCOT_HEIGHT) {
      onMorphComplete?.();
      return;
    }
    const t = setTimeout(() => setRows((r) => r + 1), REVEAL_STEP_MS);
    return () => clearTimeout(t);
  }, [rows, enabled, onMorphComplete]);

  useEffect(() => {
    if (!enabled || rows < MASCOT_HEIGHT) return;
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
  }, [enabled, rows]);

  return <PixelMascot blink={blinking} rows={rows} />;
}
