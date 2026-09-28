import { Box, Text, useInput, useStdout } from "ink";
import { type JSX, useState } from "react";
import { doubleBorder, theme } from "../theme.js";

// =============================================================================
// Help overlay (#234 UX-7)
// =============================================================================
//
// Previous version was a long vertical wall of `Section { rows }` blocks the
// user had to scroll-read. New version is a 3-column grid grouped by surface
// (Navigation / Approval / Page-specific), so the user can scan instead of
// read. Same key/label data — different visual organisation.

interface HelpRow {
  key: string;
  label: string;
}

interface HelpSection {
  title: string;
  rows: HelpRow[];
}

const NAV_SECTIONS: HelpSection[] = [
  {
    title: "Everywhere",
    rows: [
      { key: ":", label: "command console" },
      { key: "Tab / ⇧Tab", label: "next / previous page" },
      { key: "n", label: "inbox (notifications)" },
      { key: "h / ?", label: "open / close help" },
      { key: "Esc", label: "back to Home" },
      { key: "q / Ctrl-C", label: "quit" },
    ],
  },
  {
    title: "Pages",
    rows: [
      { key: "n", label: "Inbox" },
      { key: "a", label: "Agents" },
      { key: "d", label: "Delegations" },
      { key: "v", label: "Providers" },
      { key: "V", label: "Services" },
      { key: "i", label: "Integrations" },
      { key: "k", label: "Secrets / keys" },
      { key: "l", label: "Logs" },
      { key: "p", label: "Policy" },
      { key: "s", label: "Sessions" },
      { key: "c", label: "Mediator test" },
      { key: "g", label: "Settings" },
    ],
  },
  {
    // Title explicit so users don't expect [t] to fire outside the modal.
    title: "Approval modal (when open)",
    rows: [
      { key: "a / d", label: "allow once / deny" },
      { key: "A / D", label: "always allow / deny" },
      { key: "← → / [ ]", label: "next approval in queue" },
      { key: "i", label: "inspect details" },
      { key: "t", label: "toggle technical" },
      { key: "k", label: "halt session" },
      { key: "q / Ctrl-C", label: "quit (asks first)" },
    ],
  },
];

const PAGE_SECTIONS: HelpSection[] = [
  {
    title: "Logs page",
    rows: [
      { key: "/", label: "search (FTS5)" },
      { key: "1-4", label: "filter buckets" },
      { key: "↑ ↓ / Enter", label: "select / expand" },
      { key: "r", label: "replay" },
      { key: "e", label: "export" },
    ],
  },
  {
    title: "Agents page",
    rows: [
      { key: "↑ ↓ / Enter", label: "select / expand" },
      { key: "o", label: "login (OAuth / interactive)" },
      { key: "N / L", label: "edit note / change LLM" },
      { key: "d / e", label: "disable / enable" },
      { key: "b", label: "block / unblock" },
      { key: "r / x", label: "regen key / remove" },
    ],
  },
  {
    title: "Providers / Services",
    rows: [
      { key: "n", label: "configure selected" },
      { key: "o", label: "OAuth login (Claude / Codex)" },
      { key: "r", label: "rotate value" },
      { key: "d", label: "remove" },
      { key: "s", label: "show value (10s)" },
      { key: "w", label: "open walkthrough" },
    ],
  },
  {
    title: "Integrations page",
    rows: [
      { key: "n", label: "add, review, enable" },
      { key: "space", label: "enable / disable" },
      { key: "e", label: "edit access, who, keys" },
      { key: "t", label: "tools: ←→ set a rule" },
      { key: "r", label: "review (pin) tools" },
      { key: "o", label: "sign in again" },
      { key: "d", label: "remove" },
    ],
  },
];

const EXTRA_SECTIONS: HelpSection[] = [
  {
    title: "Secrets page",
    rows: [
      { key: "↑ ↓ / Enter", label: "select / expand" },
      { key: "n", label: "add custom secret" },
      { key: "v / r / d", label: "reveal / rotate / delete" },
    ],
  },
  {
    title: "Settings page",
    rows: [
      { key: "e", label: "edit SOUL.md" },
      { key: "p", label: "edit policy.yaml" },
      { key: "P", label: "open Policy page" },
      { key: "w", label: "re-run wizard" },
    ],
  },
  {
    title: "Mediator test console",
    rows: [
      { key: "← →", label: "switch source agent" },
      { key: "i", label: "input mode" },
      { key: "Enter", label: "send" },
    ],
  },
];

const ALL_SECTIONS: HelpSection[] = [...NAV_SECTIONS, ...PAGE_SECTIONS, ...EXTRA_SECTIONS];

/** A styled run of text; one help line is a list of these. */
interface Seg {
  text: string;
  color?: string;
  bold?: boolean;
}
type Line = Seg[];

const KEY_WIDTH = 12;
const COLUMN_GAP = 3;

function wrapWords(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line.length > 0) out.push(line);
  return out.length > 0 ? out : [""];
}

function sectionLines(section: HelpSection, width: number): Line[] {
  const lines: Line[] = [
    [{ text: section.title, color: theme.fg.emphasis, bold: true }],
    [{ text: "─".repeat(Math.min(section.title.length, width)), color: theme.fg.muted }],
  ];
  const labelWidth = Math.max(8, width - KEY_WIDTH - 1);
  for (const row of section.rows) {
    wrapWords(row.label, labelWidth).forEach((part, i) => {
      lines.push([
        { text: `${(i === 0 ? row.key : "").padEnd(KEY_WIDTH)} `, color: theme.accent.primary },
        { text: part, color: theme.fg.default },
      ]);
    });
  }
  return lines;
}

function lineLength(line: Line): number {
  return line.reduce((n, seg) => n + seg.text.length, 0);
}

/** The help as lines for a terminal `width` columns wide: as many section
 *  columns as fit (1 to 3), each as wide as the space allows, so labels
 *  don't wrap needlessly on a wide terminal (#657). Exported for tests. */
export function helpLines(width: number): Line[] {
  const inner = Math.max(24, width - 6);
  const cols = inner >= 3 * 34 + 2 * COLUMN_GAP ? 3 : inner >= 2 * 34 + COLUMN_GAP ? 2 : 1;
  const colWidth = Math.floor((inner - COLUMN_GAP * (cols - 1)) / cols);
  const out: Line[] = [];
  for (let i = 0; i < ALL_SECTIONS.length; i += cols) {
    const group = ALL_SECTIONS.slice(i, i + cols).map((sec) => sectionLines(sec, colWidth));
    const height = Math.max(...group.map((g) => g.length));
    if (out.length > 0) out.push([]);
    for (let r = 0; r < height; r++) {
      const line: Line = [];
      group.forEach((g, c) => {
        const cell = g[r] ?? [];
        line.push(...cell);
        if (c < group.length - 1) line.push({ text: " ".repeat(colWidth - lineLength(cell) + COLUMN_GAP) });
      });
      out.push(line);
    }
  }
  return out;
}

export interface HelpOverlayProps {
  /** Terminal columns. */
  width?: number;
  /** Rows the overlay may use (border included); it scrolls beyond that. */
  height?: number;
}

/** Title, footer, border and their margins. */
const CHROME_ROWS = 6;

export function HelpOverlay({ width, height }: HelpOverlayProps): JSX.Element {
  const { stdout } = useStdout();
  const lines = helpLines(width ?? stdout.columns ?? 100);
  const visible = height === undefined ? lines.length : Math.max(3, height - CHROME_ROWS);
  const maxOffset = Math.max(0, lines.length - visible);
  const [offset, setOffset] = useState(0);
  const top = Math.min(offset, maxOffset);
  // At 80x24 the whole help doesn't fit: it scrolls (#657).
  useInput((_input, key) => {
    if (key.upArrow) setOffset(Math.max(0, top - 1));
    else if (key.downArrow) setOffset(Math.min(maxOffset, top + 1));
    else if (key.pageUp) setOffset(Math.max(0, top - visible));
    else if (key.pageDown) setOffset(Math.min(maxOffset, top + visible));
  });
  const shown = lines.slice(top, top + visible);
  const scrolls = maxOffset > 0;
  return (
    <Box
      flexDirection="column"
      borderStyle={doubleBorder()}
      borderColor={theme.accent.primary}
      paddingX={2}
    >
      <Box justifyContent="center" marginBottom={1}>
        <Text bold color={theme.accent.primary}>
          {theme.symbols.activeDot} Foreman Help
        </Text>
      </Box>
      {shown.map((line, i) => (
        <Text key={`${top + i}`} wrap="truncate-end">
          {line.length === 0
            ? " "
            : line.map((seg, j) => (
                <Text key={j} color={seg.color} bold={seg.bold}>
                  {seg.text}
                </Text>
              ))}
        </Text>
      ))}
      <Box marginTop={1} justifyContent="center">
        <Text color={theme.fg.muted} wrap="truncate-end">
          {scrolls
            ? `↑↓ PgUp/PgDn scroll (${top + 1}–${Math.min(top + visible, lines.length)} of ${lines.length}) ${theme.symbols.bullet} h / ? / Esc close`
            : `docs: github.com/tuzlu07x/foreman ${theme.symbols.bullet} press h / ? / Esc to close`}
        </Text>
      </Box>
    </Box>
  );
}
