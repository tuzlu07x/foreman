import { Box, Text } from "ink";
import type { JSX } from "react";
import { useLayout } from "../hooks.js";
import { type Layout } from "../layout.js";
import { theme } from "../theme.js";
import type { TuiPage } from "../tui-commands.js";

// =============================================================================
// Key hints (#611)
// =============================================================================
//
// The bottom line shows what the keys do *on this page*. Page switching
// lives in the tab row at the top, so this line stays short and relevant
// instead of listing every page letter everywhere.

export interface KeyHint {
  key: string;
  label: string;
}

const PAGE_HINTS: Record<TuiPage, KeyHint[]> = {
  dashboard: [
    { key: ":", label: "command" },
    { key: "c", label: "chat" },
    { key: "n", label: "inbox" },
    { key: "t", label: "team" },
    { key: "Tab", label: "pages" },
  ],
  inbox: [{ key: "Esc", label: "home" }],
  logs: [
    { key: "/", label: "search" },
    { key: "1-4", label: "filter" },
    { key: "Enter", label: "details" },
    { key: "r", label: "replay" },
    { key: "e", label: "export" },
    { key: "Esc", label: "home" },
  ],
  policy: [
    { key: "↑↓", label: "select" },
    { key: "Enter", label: "details" },
    { key: "d", label: "on/off" },
    { key: "e", label: "edit yaml" },
    { key: "Esc", label: "home" },
  ],
  sessions: [
    { key: "↑↓", label: "select" },
    { key: "Enter", label: "details" },
    { key: "k", label: "halt" },
    { key: "Esc", label: "home" },
  ],
  delegations: [
    { key: "↑↓", label: "select" },
    { key: "Enter", label: "details" },
    { key: "Esc", label: "home" },
  ],
  agents: [
    { key: "↑↓", label: "select" },
    { key: "b", label: "block" },
    { key: "d/e", label: "disable/enable" },
    { key: "N", label: "note" },
    { key: "L", label: "LLM" },
    { key: "o", label: "login" },
    { key: "x", label: "remove" },
    { key: "Esc", label: "home" },
  ],
  secrets: [
    { key: "↑↓", label: "select" },
    { key: "v", label: "reveal" },
    { key: "r", label: "rotate" },
    { key: "n", label: "new" },
    { key: "d", label: "delete" },
    { key: "Esc", label: "home" },
  ],
  providers: [{ key: "Esc", label: "home" }],
  services: [{ key: "Esc", label: "home" }],
  integrations: [{ key: "Esc", label: "home" }],
  settings: [
    { key: "↑↓", label: "select" },
    { key: "Enter", label: "open" },
    { key: "Esc", label: "home" },
  ],
  team: [
    { key: "↑↓", label: "select" },
    { key: "n", label: "add a role" },
    { key: "Esc", label: "home" },
  ],
  chat: [
    { key: "Enter", label: "send" },
    { key: "↑", label: "earlier" },
    { key: "Tab", label: "complete" },
    { key: "Esc", label: "home" },
  ],
  test: [
    { key: "←→", label: "agent" },
    { key: "i", label: "type" },
    { key: "Esc", label: "home" },
  ],
};

/** While an approval is on screen, whatever page is underneath. */
export const APPROVAL_HINTS: KeyHint[] = [
  { key: "a", label: "allow" },
  { key: "d", label: "deny" },
  { key: "A/D", label: "always" },
  { key: "i", label: "inspect" },
  { key: "←→", label: "next" },
  { key: ":", label: "command" },
];

const GLOBAL_HINTS: KeyHint[] = [
  { key: "?", label: "help" },
  { key: "q", label: "quit" },
];

/** Hints for a page, trimmed for narrow terminals. Exported for tests. */
export function hintsFor(page: TuiPage, layout: Layout): { left: KeyHint[]; right: KeyHint[] } {
  const left = PAGE_HINTS[page] ?? [];
  if (layout === "narrow") return { left: left.slice(0, 3), right: GLOBAL_HINTS };
  return { left, right: GLOBAL_HINTS };
}

export interface StatusBarProps {
  page?: TuiPage;
  quitConfirm?: boolean;
  /** An approval is on screen: show its keys instead of the page's. */
  approval?: boolean;
  /** The page shows its own keys for what's on screen (a form, a picker):
   *  leave them out here instead of listing the page's usual ones. */
  pageKeysShown?: boolean;
}

export function StatusBar({ page = "dashboard", quitConfirm, approval, pageKeysShown }: StatusBarProps): JSX.Element {
  const layout = useLayout();
  if (quitConfirm) {
    // One paragraph that wraps as a whole, and the keys on their own line:
    // side-by-side <Text>s ran into each other at 80 columns (#657).
    return (
      <Box paddingX={1} flexDirection="column">
        <Text wrap="wrap">
          <Text color={theme.accent.warning} bold>
            Quit Foreman? Agents stop being guarded.
          </Text>
          {approval ? <Text color={theme.fg.muted}> Waiting calls will be denied.</Text> : null}
        </Text>
        <Text>
          <Text color={theme.fg.emphasis} bold>
            y
          </Text>
          <Text color={theme.fg.muted}> quit  ·  </Text>
          <Text color={theme.fg.emphasis} bold>
            n
          </Text>
          <Text color={theme.fg.muted}> stay</Text>
        </Text>
      </Box>
    );
  }
  const hints = hintsFor(page, layout);
  const left = approval ? APPROVAL_HINTS : pageKeysShown ? [] : hints.left;
  const { right } = hints;
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Hints hints={left} />
      <Hints hints={right} />
    </Box>
  );
}

function Hints({ hints }: { hints: KeyHint[] }): JSX.Element {
  return (
    <Text wrap="truncate-end">
      {hints.map((h, i) => (
        <Text key={`${h.key}-${i}`}>
          {i > 0 ? <Text color={theme.fg.muted}>{"  ·  "}</Text> : null}
          <Text color={theme.fg.emphasis} bold>
            {h.key}
          </Text>
          <Text color={theme.fg.muted}>{` ${h.label}`}</Text>
        </Text>
      ))}
    </Text>
  );
}
