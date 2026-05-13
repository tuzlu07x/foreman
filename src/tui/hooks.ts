import { useEffect, useState } from "react";
import { useStdout } from "ink";
import { LAYOUT_MEDIUM_MIN, layoutForCols, type Layout } from "./layout.js";

export interface TerminalSize {
  cols: number;
  rows: number;
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => readSize(stdout));
  useEffect(() => {
    const onResize = (): void => setSize(readSize(stdout));
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}

export function useLayout(): Layout {
  const { cols } = useTerminalSize();
  return layoutForCols(cols);
}

function readSize(stdout: NodeJS.WriteStream): TerminalSize {
  return {
    cols: stdout.columns ?? LAYOUT_MEDIUM_MIN,
    rows: stdout.rows ?? 24,
  };
}
