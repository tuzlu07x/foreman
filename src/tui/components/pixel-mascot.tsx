import { Box, Text } from "ink";
import type { JSX } from "react";
import { MASCOT_COLUMNS, MASCOT_PALETTE, mascotRows, mascotVisible, pixelRuns } from "./mascot-frames.js";

export interface PixelMascotProps {
  /** Eyes closed. */
  blink?: boolean;
  /** Rows shown, from the top (the boot reveal); the rest are blank, so
   *  the layout doesn't move while it draws. Default: all. */
  rows?: number;
}

/** Foreman's mascot (mascot-frames.ts). Nothing without colour. */
export function PixelMascot({ blink = false, rows }: PixelMascotProps): JSX.Element | null {
  if (!mascotVisible()) return null;
  const all = mascotRows(blink);
  const shown = rows ?? all.length;
  return (
    <Box flexDirection="column" width={MASCOT_COLUMNS} flexShrink={0}>
      {all.map((row, i) => (
        <Text key={i}>
          {i >= shown
            ? " ".repeat(MASCOT_COLUMNS)
            : pixelRuns(row).map((run, j) =>
                run.pixel === null ? (
                  <Text key={j}>{"  ".repeat(run.width)}</Text>
                ) : (
                  <Text key={j} backgroundColor={MASCOT_PALETTE[run.pixel]}>
                    {"  ".repeat(run.width)}
                  </Text>
                ),
              )}
        </Text>
      ))}
    </Box>
  );
}
