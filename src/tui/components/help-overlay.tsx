import { Box, Text } from "ink";
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
    title: "Navigation",
    rows: [
      { key: "h / ?", label: "open / close help" },
      { key: "Esc", label: "back to dashboard" },
      { key: "q / Ctrl-C", label: "quit (with confirm)" },
    ],
  },
  {
    title: "Pages",
    rows: [
      { key: "a", label: "Agents" },
      { key: "v", label: "Providers" },
      { key: "V", label: "Services" },
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
      { key: "i", label: "inspect details" },
      { key: "t", label: "toggle technical" },
      { key: "k", label: "halt session" },
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
      { key: "b / r", label: "block / remove" },
      { key: "R", label: "regen key" },
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
];

const EXTRA_SECTIONS: HelpSection[] = [
  {
    title: "Secrets page",
    rows: [
      { key: "↑ ↓ / Enter", label: "select / expand" },
      { key: "n", label: "add custom secret" },
      { key: "v / r / d", label: "reveal / rotate / remove" },
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

export function HelpOverlay(): JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle={doubleBorder()}
      borderColor={theme.accent.primary}
      paddingX={2}
      paddingY={1}
    >
      <Box justifyContent="center" marginBottom={1}>
        <Text bold color={theme.accent.primary}>
          {theme.symbols.activeDot} Foreman Help
        </Text>
      </Box>

      <ColumnRow sections={NAV_SECTIONS} />
      <Box marginTop={1}>
        <ColumnRow sections={PAGE_SECTIONS} />
      </Box>
      <Box marginTop={1}>
        <ColumnRow sections={EXTRA_SECTIONS} />
      </Box>

      <Box marginTop={1} justifyContent="center">
        <Text color={theme.fg.muted}>
          docs: github.com/tuzlu07x/foreman {theme.symbols.bullet} press h / ? /
          Esc to close
        </Text>
      </Box>
    </Box>
  );
}

function ColumnRow({ sections }: { sections: HelpSection[] }): JSX.Element {
  // Fixed-width columns so ink's flex layout doesn't collapse cells when the
  // terminal is narrow (which made labels wrap character-by-character).
  // 32 cols x 3 = 96 cols + paddings → fits comfortably in 100+ wide terms.
  return (
    <Box flexDirection="row">
      {sections.map((section, i) => (
        <Box
          key={section.title}
          flexDirection="column"
          width={32}
          paddingRight={i === sections.length - 1 ? 0 : 2}
        >
          <SectionColumn section={section} />
        </Box>
      ))}
    </Box>
  );
}

function SectionColumn({ section }: { section: HelpSection }): JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold color={theme.fg.emphasis}>
        {section.title}
      </Text>
      <Text color={theme.fg.muted}>{"─".repeat(section.title.length)}</Text>
      {section.rows.map((row) => (
        <Box key={row.key}>
          <Text>
            <Text color={theme.accent.primary}>{padRight(row.key, 12)}</Text>{" "}
            <Text color={theme.fg.default}>{row.label}</Text>
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function padRight(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}
