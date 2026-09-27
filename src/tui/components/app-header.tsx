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
  { page: "sessions", label: "Sessions", key: "s" },
  { page: "delegations", label: "Delegations", key: "d" },
  { page: "logs", label: "Logs", key: "l" },
  { page: "policy", label: "Policy", key: "p" },
  { page: "secrets", label: "Keys", key: "k" },
  { page: "providers", label: "Providers", key: "v" },
  { page: "services", label: "Services", key: "V" },
  { page: "settings", label: "Settings", key: "g" },
  { page: "chat", label: "Test", key: "c" },
];

export function nextTab(page: TuiPage, delta: number): TuiPage {
  const i = TABS.findIndex((t) => t.page === page);
  const n = TABS.length;
  return TABS[((i === -1 ? 0 : i) + delta + n) % n]!.page;
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
  // Show as many tabs as fit, keeping the active one visible.
  const labels = TABS.map((t) => `${t.label}${t.page === "inbox" && unread > 0 ? ` ${unread}` : ""}`);
  const cost = (i: number): number => labels[i]!.length + 4;
  const budget = Math.max(20, width - 26);
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
        {TABS.slice(from, to).map((t, i) => {
          const isActive = t.page === page;
          const label = labels[from + i]!;
          return (
            <Text key={t.page}>
              {isActive ? (
                <Text color={theme.accent.primary} bold>{`▎${label} `}</Text>
              ) : (
                <Text color={t.page === "inbox" && unread > 0 ? theme.accent.info : theme.fg.muted}>
                  {` ${label} `}
                </Text>
              )}
              <Text color={theme.fg.muted}>{"  "}</Text>
            </Text>
          );
        })}
        {to < TABS.length ? <Text color={theme.fg.muted}>{"›"}</Text> : null}
      </Text>
      <Text color={theme.fg.muted}>
        <Text color={theme.fg.default}>Tab</Text> next · <Text color={theme.fg.default}>:</Text> command
      </Text>
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
