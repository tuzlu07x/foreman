import { Box, Text } from "ink";
import type { Page } from "../app.js";
import { useLayout } from "../hooks.js";
import { type Layout } from "../layout.js";
import { theme } from "../theme.js";

// =============================================================================
// Status bar (#234 UX-4)
// =============================================================================
//
// Three responsive layouts:
//   - wide   (≥ 120 col):  active page label ▸ main hotkeys with words ...
//                          right-aligned admin (help + quit)
//   - medium (80–119):     active page ▸ single-letter hotkeys ... [h][q]
//   - narrow (< 80):       two lines — first shows the active page, second
//                          shows the minimal hotkey set
//
// The active page's letter is bolded + accent.primary so the user always knows
// where they are without reading text.

export interface StatusBarProps {
  /** Active page so we can light up its letter. */
  page?: Page;
  quitConfirm?: boolean;
  version?: string;
}

// Logical key → label table. Single source so the responsive layouts pull
// from the same data and we don't drift one but not the other.
interface KeyEntry {
  page: Page | "help" | "quit";
  letter: string;
  label: string;
}

const MAIN_KEYS: KeyEntry[] = [
  { page: "agents", letter: "a", label: "agents" },
  { page: "providers", letter: "v", label: "providers" },
  { page: "services", letter: "V", label: "services" },
  { page: "secrets", letter: "k", label: "keys" },
  { page: "logs", letter: "l", label: "logs" },
  { page: "policy", letter: "p", label: "policy" },
  { page: "sessions", letter: "s", label: "sessions" },
];

const SECONDARY_KEYS: KeyEntry[] = [
  { page: "chat", letter: "c", label: "chat" },
  { page: "settings", letter: "g", label: "settings" },
];

const ADMIN_KEYS: KeyEntry[] = [
  { page: "help", letter: "h", label: "help" },
  { page: "quit", letter: "q", label: "quit" },
];

const PAGE_LABELS: Record<Page, string> = {
  dashboard: "Dashboard",
  logs: "Logs",
  policy: "Policy",
  sessions: "Sessions",
  agents: "Agents",
  providers: "Providers",
  services: "Services",
  secrets: "Secrets",
  settings: "Settings",
  chat: "Chat",
};

// -----------------------------------------------------------------------------
// Pure layout builder — exported for unit tests
// -----------------------------------------------------------------------------

export interface StatusBarLayout {
  rows: StatusBarRow[];
  showVersion: boolean;
}

export interface StatusBarRow {
  /** Page label at the start of the row, when present. */
  active?: string;
  /** Left-side hotkeys (page navigation). */
  leftKeys: KeyEntry[];
  /** Right-side hotkeys (admin / system). */
  rightKeys: KeyEntry[];
  /** Render each hotkey with its full label vs. just the letter. */
  withLabels: boolean;
}

export function buildStatusBarLayout(
  layout: Layout,
  page: Page = "dashboard",
): StatusBarLayout {
  const activeLabel = `${theme.symbols.bullet} ${PAGE_LABELS[page]}`;

  if (layout === "wide") {
    // One row, everything with labels, page indicator + admin on the right.
    return {
      rows: [
        {
          active: activeLabel,
          leftKeys: [...MAIN_KEYS, ...SECONDARY_KEYS],
          rightKeys: ADMIN_KEYS,
          withLabels: true,
        },
      ],
      showVersion: true,
    };
  }

  if (layout === "medium") {
    // One row, single-letter hotkeys only, page indicator still on the left.
    return {
      rows: [
        {
          active: activeLabel,
          leftKeys: [...MAIN_KEYS, ...SECONDARY_KEYS],
          rightKeys: ADMIN_KEYS,
          withLabels: false,
        },
      ],
      showVersion: true,
    };
  }

  // Narrow: two lines — page on its own line, hotkeys below.
  return {
    rows: [
      {
        active: activeLabel,
        leftKeys: [],
        rightKeys: [],
        withLabels: false,
      },
      {
        leftKeys: MAIN_KEYS,
        rightKeys: ADMIN_KEYS,
        withLabels: false,
      },
    ],
    showVersion: false,
  };
}

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

export function StatusBar({
  page = "dashboard",
  quitConfirm,
  version = "0.1.0",
}: StatusBarProps): JSX.Element {
  const layout = useLayout();
  if (quitConfirm) {
    return (
      <Box paddingX={1}>
        <Text color={theme.accent.warning}>Quit? [y/n]</Text>
      </Box>
    );
  }
  const { rows, showVersion } = buildStatusBarLayout(layout, page);
  return (
    <Box paddingX={1} flexDirection="column">
      {rows.map((row, i) => (
        <StatusRow
          key={i}
          row={row}
          page={page}
          showVersion={showVersion && i === 0}
          version={version}
        />
      ))}
    </Box>
  );
}

function StatusRow({
  row,
  page,
  showVersion,
  version,
}: {
  row: StatusBarRow;
  page: Page;
  showVersion: boolean;
  version: string;
}): JSX.Element {
  // When the row has only an active label and nothing else, just render that.
  if (row.leftKeys.length === 0 && row.rightKeys.length === 0 && row.active) {
    return (
      <Box justifyContent="space-between">
        <Text color={theme.accent.primary}>{row.active}</Text>
        {showVersion && (
          <Text color={theme.fg.muted}>{`🦫 v${version}`}</Text>
        )}
      </Box>
    );
  }

  return (
    <Box justifyContent="space-between">
      <Box>
        {row.active ? (
          <>
            <Text color={theme.accent.primary} bold>
              {row.active}
            </Text>
            <Text color={theme.fg.muted}>{"  "}</Text>
          </>
        ) : null}
        {row.leftKeys.map((k, i) => (
          <Hotkey
            key={`l-${i}`}
            entry={k}
            withLabel={row.withLabels}
            active={k.page === page}
          />
        ))}
      </Box>
      <Box>
        {row.rightKeys.map((k, i) => (
          <Hotkey
            key={`r-${i}`}
            entry={k}
            withLabel={row.withLabels}
            active={false}
          />
        ))}
        {showVersion && (
          <>
            <Text color={theme.fg.muted}>{"  "}</Text>
            <Text color={theme.fg.muted}>{`🦫 v${version}`}</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

function Hotkey({
  entry,
  withLabel,
  active,
}: {
  entry: KeyEntry;
  withLabel: boolean;
  active: boolean;
}): JSX.Element {
  // The active page's hotkey letter is highlighted: bold + accent. Others
  // stay muted-grey so they don't compete for attention.
  const letterColor = active ? theme.accent.primary : theme.fg.muted;
  const labelColor = active ? theme.fg.emphasis : theme.fg.muted;
  return (
    <Text>
      <Text color={theme.fg.muted}>{"["}</Text>
      <Text color={letterColor} bold={active}>
        {entry.letter}
      </Text>
      <Text color={theme.fg.muted}>{"]"}</Text>
      {withLabel ? (
        <>
          <Text color={labelColor}>{` ${entry.label}`}</Text>
          <Text color={theme.fg.muted}>{"  "}</Text>
        </>
      ) : (
        <Text color={theme.fg.muted}>{" "}</Text>
      )}
    </Text>
  );
}
