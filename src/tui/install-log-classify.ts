// =============================================================================
// Install-log classifier (#459)
// =============================================================================
//
// The wizard's install step streams the upstream installer output line-by-line
// (uv/pip/cargo/brew/npm/curl, several hundred lines per agent). Rendering
// every line tail-style turns the install screen into a scrolling wall of
// text the user can't keep up with. This helper splits the stream into:
//
//   - Headlines: lines Foreman's own install loop emits — `▸ Hermes`,
//     `✓ wrote MCP snippet`, `⚠ found broken binary…`. These are
//     human-curated milestones and stay visible.
//   - Verbose lines: raw upstream output. Collapsed to a single
//     "most-recent-milestone" status line under the spinner.
//
// On error the wizard switches back to verbose so the user can see the
// real failure context.

export interface ClassifiedInstallLog {
  /** Lines that begin with a Foreman-emitted progress marker. Rendered
   *  in-line; preserves their order in the log. */
  headlines: string[];
  /** The most recent upstream-installer milestone (e.g. `Resolved 217
   *  packages in 4s`). Shown as the single live status under the
   *  spinner. `null` when no verbose line matched a known milestone
   *  yet — the spinner renders `installing…` instead. */
  lastMilestone: string | null;
  /** Count of raw upstream lines collapsed into the spinner status —
   *  surfaced as `(N hidden — press [l] later for full log)`. */
  verboseLineCount: number;
}

const HEADLINE_PREFIXES = ["▸", "✓", "✗", "⚠", "✦", "▰", "◦", "⟳"];

export function classifyInstallLog(lines: string[]): ClassifiedInstallLog {
  const headlines: string[] = [];
  let lastMilestone: string | null = null;
  let verboseLineCount = 0;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.length === 0) continue;
    if (HEADLINE_PREFIXES.some((p) => trimmed.startsWith(p))) {
      headlines.push(line);
      continue;
    }
    verboseLineCount++;
    const milestone = extractMilestone(trimmed);
    if (milestone) lastMilestone = milestone;
  }
  return { headlines, lastMilestone, verboseLineCount };
}

/**
 * Extract a human-readable milestone from a single upstream installer
 * line. Returns `null` when the line is noise (license blurbs, debug
 * spam, etc) — the previous milestone stays on screen.
 */
export function extractMilestone(line: string): string | null {
  // uv / pip / cargo style — these are the most common Foreman agents
  if (/^Resolved \d+ packages?/i.test(line)) return line;
  if (/^Installed \d+ packages?/i.test(line)) return line;
  if (/^Downloading\b/i.test(line)) return line;
  if (/^Downloaded \d+/i.test(line)) return line;
  if (/^Building wheels?\b/i.test(line)) return line;
  if (/^Compiling\b/i.test(line)) return line;
  if (/^Preparing\b/i.test(line)) return line;
  // brew
  if (/^==>\s*Downloading\b/i.test(line)) return line.replace(/^==>\s*/, "");
  if (/^==>\s*Pouring\b/i.test(line)) return line.replace(/^==>\s*/, "");
  if (/^==>\s*Caveats\b/i.test(line)) return line.replace(/^==>\s*/, "");
  // npm
  if (/^added \d+ packages?/i.test(line)) return line;
  if (/^npm warn\b/i.test(line)) return null;
  // curl/bash style
  if (/^Cloning into\b/i.test(line)) return line;
  if (/^Receiving objects:/i.test(line)) return null; // progress noise
  // hermes-specific (skill registration, config writes)
  if (/^Loaded \d+ skill/i.test(line)) return line;
  if (/^Wrote \S+/i.test(line)) return line;
  if (/^Created \S+/i.test(line)) return line;
  return null;
}
