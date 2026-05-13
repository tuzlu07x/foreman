export type Layout = "wide" | "medium" | "narrow";

export const LAYOUT_WIDE_MIN = 120;
export const LAYOUT_MEDIUM_MIN = 80;

export function layoutForCols(cols: number): Layout {
  if (cols >= LAYOUT_WIDE_MIN) return "wide";
  if (cols >= LAYOUT_MEDIUM_MIN) return "medium";
  return "narrow";
}
