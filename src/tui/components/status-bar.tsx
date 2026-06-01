import { Box, Text } from "ink";
import type { Page } from "../app.js";
import { useLayout } from "../hooks.js";
import { type Layout } from "../layout.js";
import { theme } from "../theme.js";
import { FOREMAN_VERSION } from "../../version.js";

export interface StatusBarProps {
  page?: Page;
  quitConfirm?: boolean;
  version?: string;
}

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
  { page: "chat", letter: "c", label: "test" },
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
  delegations: "Delegations",
  agents: "Agents",
  providers: "Providers",
  services: "Services",
  secrets: "Secrets",
  settings: "Settings",
  chat: "Test console",
};

// -----------------------------------------------------------------------------
// Pure layout builder — exported for unit tests
// -----------------------------------------------------------------------------

export interface StatusBarLayout {
  rows: StatusBarRow[];
  showVersion: boolean;
}

export interface StatusBarRow {
  active?: string;
  leftKeys: KeyEntry[];
  rightKeys: KeyEntry[];
  withLabels: boolean;
}

export function buildStatusBarLayout(
  layout: Layout,
  page: Page = "dashboard",
): StatusBarLayout {
  const activeLabel = `${theme.symbols.bullet} ${PAGE_LABELS[page]}`;

  if (layout === "wide") {
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
  version = FOREMAN_VERSION,
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
  if (row.leftKeys.length === 0 && row.rightKeys.length === 0 && row.active) {
    return (
      <Box justifyContent="space-between">
        <Text color={theme.accent.primary}>{row.active}</Text>
        {showVersion && <Text color={theme.fg.muted}>{`🦫 v${version}`}</Text>}
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
        <Text color={theme.fg.muted}> </Text>
      )}
    </Text>
  );
}
