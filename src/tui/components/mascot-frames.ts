// =============================================================================
// Foreman's mascot: a pixel-art beaver foreman's head
// =============================================================================
//
// Each pixel is two spaces with a background colour, so a pixel is roughly
// square in a terminal cell (about 1:2) and every row is exactly
// 2 × WIDTH columns wide in every terminal and font. The block and
// box-drawing glyphs the old mascot used (▟ ▓ ● ▼) are "ambiguous width" in
// Unicode: some terminals draw them two cells wide, and chafa's output
// depended on an optional binary. A space is one cell everywhere.

export type MascotPixel = "hat" | "brim" | "fur" | "eye" | "muzzle" | "nose" | "tooth";

/** Colours per pixel kind. */
export const MASCOT_PALETTE: Readonly<Record<MascotPixel, string>> = {
  hat: "#F5B82E",
  brim: "#D08A16",
  fur: "#9A6233",
  eye: "#1E140C",
  muzzle: "#EBCB9F",
  nose: "#3B2414",
  tooth: "#FFFFFF",
};

const KEY: Readonly<Record<string, MascotPixel | null>> = {
  ".": null,
  Y: "hat",
  H: "brim",
  B: "fur",
  E: "eye",
  C: "muzzle",
  N: "nose",
  T: "tooth",
};

const OPEN: readonly string[] = [
  "...YYYY...",
  ".YYYYYYYY.",
  "HHHHHHHHHH",
  ".BBBBBBBB.",
  ".BEBBBBEB.",
  ".BBCNNCBB.",
  "..BCTTCB..",
];

/** Eyes closed: the eye pixels become fur for a blink. */
const BLINK: readonly string[] = OPEN.map((row, i) => (i === 4 ? row.replace(/E/g, "B") : row));

/** Pixels per row. */
export const MASCOT_WIDTH = OPEN[0]!.length;
/** Rows. */
export const MASCOT_HEIGHT = OPEN.length;
/** Terminal columns the mascot takes (two per pixel). */
export const MASCOT_COLUMNS = MASCOT_WIDTH * 2;

export type MascotRow = readonly (MascotPixel | null)[];

/** The mascot as rows of pixels (null: transparent). */
export function mascotRows(blink = false): MascotRow[] {
  return (blink ? BLINK : OPEN).map((row) => [...row].map((c) => KEY[c] ?? null));
}

/** A row as runs of equal pixels, so it renders as few coloured segments. */
export function pixelRuns(row: MascotRow): Array<{ pixel: MascotPixel | null; width: number }> {
  const runs: Array<{ pixel: MascotPixel | null; width: number }> = [];
  for (const pixel of row) {
    const last = runs.at(-1);
    if (last && last.pixel === pixel) last.width += 1;
    else runs.push({ pixel, width: 1 });
  }
  return runs;
}

/** Whether the mascot can be drawn: it is made of background colours, so a
 *  terminal without colour (NO_COLOR, FORCE_COLOR=0, a pipe) shows none. */
export function mascotVisible(env: NodeJS.ProcessEnv = process.env, stream: { isTTY?: boolean } = process.stdout): boolean {
  if (env.FORCE_COLOR === "0" || (env.NO_COLOR !== undefined && env.NO_COLOR !== "" && env.FORCE_COLOR === undefined)) {
    return false;
  }
  return stream.isTTY === true || (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0");
}
