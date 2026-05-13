import { Box, Text } from "ink";
import BigText from "ink-big-text";
import Gradient from "ink-gradient";
import { useEffect, useState } from "react";
import { isAsciiMode, theme } from "../theme.js";

const TYPEWRITER_STEP_MS = 55;

export interface WordmarkProps {
  text: string;
  enabled: boolean;
  onComplete?: () => void;
}

export function Wordmark({
  text,
  enabled,
  onComplete,
}: WordmarkProps): JSX.Element {
  const ascii = isAsciiMode();
  const [revealed, setRevealed] = useState<number>(enabled ? 1 : text.length);

  useEffect(() => {
    if (!enabled) {
      onComplete?.();
      return;
    }
    if (revealed >= text.length) {
      onComplete?.();
      return;
    }
    const t = setTimeout(
      () => setRevealed((r) => Math.min(text.length, r + 1)),
      TYPEWRITER_STEP_MS,
    );
    return () => clearTimeout(t);
  }, [revealed, enabled, text.length, onComplete]);

  const visible = text.slice(0, Math.max(1, revealed));

  if (ascii) {
    return (
      <Box>
        <Text bold color={theme.accent.primary}>
          {visible}
        </Text>
      </Box>
    );
  }

  return (
    <Box>
      <Gradient colors={[theme.accent.primary, theme.accent.primaryAlt]}>
        <BigText text={visible} font="block" />
      </Gradient>
    </Box>
  );
}
