import { Box, Text } from "ink";
import type { JSX } from "react";
import type { InboxItem } from "../../db/schema.js";
import { FOREMAN_VERSION } from "../../version.js";
import type { TuiPage } from "../tui-commands.js";
import { theme } from "../theme.js";
import { levelGlyph } from "../pages/inbox-page.js";

// =============================================================================
// Header, page tabs and toast (#611)
// =============================================================================
//
// One line answers "is anything waiting on me?" from every page: agents
// online, approvals pending, unread notifications, today's allow/deny
// counts. The tab row under it makes every page discoverable without the
// help overlay.

export interface HeaderStats {
  agentsOnline: number;
  agentsTotal: number;
  pendingApprovals: number;
  unread: number;
  allowedToday: number;
  deniedToday: number;
  /** Attached to the background gateway: "attached" while it runs,
   *  "stopped" once it is gone. Undefined when this process is the
   *  gateway itself. */
  gateway?: "attached" | "stopped";
}

export function AppHeader({ stats, width }: { stats: HeaderStats; width: number }): JSX.Element {
  const compact = width < 125;
  const clock = new Date().toTimeString().slice(0, 5);
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text wrap="truncate-end">
        <Text>{theme.symbols.brand} </Text>
        <Text color={theme.accent.primary} bold>
          FOREMAN
        </Text>
        <Chip>
          <Text color={theme.accent.success}>{theme.symbols.activeDot}</Text>
          <Text color={theme.fg.default}>{compact ? " on" : " guarding"}</Text>
        </Chip>
        {stats.gateway === "attached" ? (
          <Chip>
            <Text color={theme.accent.info}>{compact ? "attached" : "attached to the background gateway"}</Text>
          </Chip>
        ) : stats.gateway === "stopped" ? (
          <Chip>
            <Text color={theme.accent.warning} bold>
              {compact ? `${theme.symbols.warn} gateway stopped` : `${theme.symbols.warn} background gateway stopped`}
            </Text>
          </Chip>
        ) : null}
        <Chip>
          <Text color={theme.fg.default}>{`${stats.agentsOnline}/${stats.agentsTotal}`}</Text>
          <Text color={theme.fg.muted}> agents</Text>
        </Chip>
        <Chip>
          {stats.pendingApprovals > 0 ? (
            <Text color={theme.accent.warning} bold>
              {`${theme.symbols.warn} ${stats.pendingApprovals} waiting`}
            </Text>
          ) : (
            <Text color={theme.fg.muted}>{`${theme.symbols.check} nothing waiting`}</Text>
          )}
        </Chip>
        <Chip>
          {stats.unread > 0 ? (
            <Text color={theme.accent.info} bold>{`${theme.symbols.inbox} ${stats.unread} new`}</Text>
          ) : (
            <Text color={theme.fg.muted}>{`${theme.symbols.inbox} 0`}</Text>
          )}
        </Chip>
        {compact ? null : (
          <Chip>
            <Text color={theme.accent.success}>{`${theme.symbols.check} ${stats.allowedToday}`}</Text>
            <Text color={theme.fg.muted}> </Text>
            <Text color={theme.accent.danger}>{`${theme.symbols.cross} ${stats.deniedToday}`}</Text>
            <Text color={theme.fg.muted}> today</Text>
          </Chip>
        )}
      </Text>
      {compact ? null : <Text color={theme.fg.muted}>{`v${FOREMAN_VERSION} · ${clock}`}</Text>}
    </Box>
  );
}

function Chip({ children }: { children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <Text>
      <Text color={theme.fg.muted}>{"  │  "}</Text>
      {children}
    </Text>
  );
}

export interface TabSpec {
  page: TuiPage;
  label: string;
  key: string;
}

/** Pages in tab order. `key` is the page's single-letter hotkey. */
export const TABS: TabSpec[] = [
  { page: "dashboard", label: "Home", key: "Esc" },
  { page: "inbox", label: "Inbox", key: "n" },
  { page: "agents", label: "Agents", key: "a" },
  { page: "team", label: "Team", key: "t" },
  { page: "chat", label: "Chat", key: "c" },
  { page: "sessions", label: "Sessions", key: "s" },
  { page: "delegations", label: "Delegations", key: "d" },
  { page: "logs", label: "Logs", key: "l" },
  { page: "policy", label: "Policy", key: "p" },
  { page: "secrets", label: "Secrets", key: "k" },
  { page: "providers", label: "Providers", key: "v" },
  { page: "services", label: "Services", key: "V" },
  { page: "integrations", label: "Integrations", key: "i" },
  { page: "settings", label: "Settings", key: "g" },
];

export function nextTab(page: TuiPage, delta: number): TuiPage {
  const i = TABS.findIndex((t) => t.page === page);
  const n = TABS.length;
  return TABS[((i === -1 ? 0 : i) + delta + n) % n]!.page;
}

/** Tab labels, the Inbox one with its unread count. */
function tabLabels(unread: number): string[] {
  return TABS.map((t) => `${t.label}${t.page === "inbox" && unread > 0 ? ` ${unread}` : ""}`);
}

/** A tab's width beyond its label: ` label ` plus the two-space gap. */
const TAB_GAP = 4;
/** "Tab next · : command" on the right of a single row. */
const HINT_WIDTH = 26;

/** Every tab laid out in rows of `width` columns, or null when it takes
 *  more than two rows (the bar then scrolls instead). Exported for tests. */
export function tabRowsFor(width: number, unread = 0): number[][] | null {
  const labels = tabLabels(unread);
  const total = labels.reduce((sum, l) => sum + l.length + TAB_GAP, 0);
  if (total <= Math.max(20, width - HINT_WIDTH)) return [labels.map((_, i) => i)];
  // Two rows pack tighter: one space between tabs instead of two.
  const room = width - 2;
  const rows: number[][] = [[]];
  let used = 0;
  labels.forEach((l, i) => {
    const cost = l.length + TAB_GAP - 1;
    if (used + cost > room && rows.at(-1)!.length > 0) {
      rows.push([]);
      used = 0;
    }
    rows.at(-1)!.push(i);
    used += cost;
  });
  return rows.length <= 2 ? rows : null;
}

/** How many terminal rows the tab bar takes (1 or 2). */
export function navTabsHeight(width: number, unread = 0): number {
  return tabRowsFor(width, unread)?.length ?? 1;
}

export function NavTabs({
  page,
  unread,
  width,
}: {
  page: TuiPage;
  unread: number;
  width: number;
}): JSX.Element {
  const labels = tabLabels(unread);
  const tab = (i: number, gap = "  "): JSX.Element => {
    const t = TABS[i]!;
    const label = labels[i]!;
    return (
      <Text key={t.page}>
        {t.page === page ? (
          <Text color={theme.accent.primary} bold>{`▎${label} `}</Text>
        ) : (
          <Text color={t.page === "inbox" && unread > 0 ? theme.accent.info : theme.fg.muted}>{` ${label} `}</Text>
        )}
        <Text color={theme.fg.muted}>{gap}</Text>
      </Text>
    );
  };
  const hint = (
    <Text color={theme.fg.muted}>
      <Text color={theme.fg.default}>Tab</Text> next · <Text color={theme.fg.default}>:</Text> command
    </Text>
  );
  // Every page in view: one row, or two when one isn't wide enough.
  const rows = tabRowsFor(width, unread);
  if (rows && rows.length === 1) {
    return (
      <Box justifyContent="space-between" paddingX={1}>
        <Text wrap="truncate-end">{rows[0]!.map((i) => tab(i))}</Text>
        {hint}
      </Box>
    );
  }
  if (rows) {
    return (
      <Box flexDirection="column" paddingX={1}>
        {rows.map((r, n) => (
          <Text key={n} wrap="truncate-end">
            {r.map((i) => tab(i, " "))}
          </Text>
        ))}
      </Box>
    );
  }
  // Too narrow even for two rows: as many as fit, keeping the active one visible.
  const cost = (i: number): number => labels[i]!.length + TAB_GAP;
  const budget = Math.max(20, width - HINT_WIDTH);
  const active = Math.max(0, TABS.findIndex((t) => t.page === page));
  let from = 0;
  let used = 0;
  let to = 0;
  while (to < TABS.length && used + cost(to) <= budget) used += cost(to++);
  while (active >= to && to < TABS.length) {
    used += cost(to++);
    while (used > budget && from < active) used -= cost(from++);
  }
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text wrap="truncate-end">
        {from > 0 ? <Text color={theme.fg.muted}>{"‹ "}</Text> : null}
        {Array.from({ length: to - from }, (_, k) => tab(from + k))}
        {to < TABS.length ? <Text color={theme.fg.muted}>{"›"}</Text> : null}
      </Text>
      {hint}
    </Box>
  );
}

export function Toast({ item }: { item: InboxItem }): JSX.Element {
  const { glyph, color } = levelGlyph(item.level);
  return (
    <Box paddingX={1}>
      <Text wrap="truncate-end">
        <Text color={color} bold>{`${glyph} ${item.title}`}</Text>
        {item.body ? <Text color={theme.fg.muted}>{`  ${item.body}`}</Text> : null}
        <Text color={theme.fg.muted}>{"   — "}</Text>
        <Text color={theme.fg.default}>n</Text>
        <Text color={theme.fg.muted}> inbox</Text>
      </Text>
    </Box>
  );
}
