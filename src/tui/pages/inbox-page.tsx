import { Box, Text, useInput } from "ink";
import { type JSX, useMemo, useState } from "react";
import type { InboxItem } from "../../db/schema.js";
import { relativeTime } from "../format.js";
import { roundBorder, theme } from "../theme.js";

// Notification centre (#613): everything Foreman wanted you to know,
// newest first, with read state that survives restarts.

type Filter = "all" | "unread" | "warnings";
const FILTERS: Filter[] = ["all", "unread", "warnings"];
const FILTER_LABEL: Record<Filter, string> = {
  all: "all",
  unread: "unread",
  warnings: "warnings & critical",
};

export interface InboxPageProps {
  items: InboxItem[];
  unread: number;
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  /** Key handling is off while a modal or the command bar is open. */
  active: boolean;
  height: number;
  now?: number;
}

export function levelGlyph(level: InboxItem["level"]): { glyph: string; color: string } {
  if (level === "critical") return { glyph: theme.symbols.cross, color: theme.accent.danger };
  if (level === "warning") return { glyph: theme.symbols.warn, color: theme.accent.warning };
  return { glyph: theme.symbols.info, color: theme.accent.info };
}

export function filterInbox(items: InboxItem[], filter: Filter): InboxItem[] {
  if (filter === "unread") return items.filter((i) => i.readAt === null);
  if (filter === "warnings") return items.filter((i) => i.level !== "info");
  return items;
}

/** Identical notices shown as one row (e.g. the same crash on every start). */
export interface InboxGroup {
  /** The newest item: the row shows its time, level and details. */
  latest: InboxItem;
  /** Every item in the group, newest first. */
  items: InboxItem[];
  unread: number;
}

/** Groups notices with the same agent, kind, level and text into one row,
 *  keeping the count and the newest time. `items` is newest first; so is
 *  the result, with each group placed where its newest item was. */
export function groupInbox(items: InboxItem[]): InboxGroup[] {
  const groups = new Map<string, InboxGroup>();
  const out: InboxGroup[] = [];
  for (const item of items) {
    const key = JSON.stringify([item.agentId, item.kind, item.level, item.title, item.body]);
    const group = groups.get(key);
    if (group) {
      group.items.push(item);
      if (item.readAt === null) group.unread++;
      continue;
    }
    const fresh: InboxGroup = { latest: item, items: [item], unread: item.readAt === null ? 1 : 0 };
    groups.set(key, fresh);
    out.push(fresh);
  }
  return out;
}

export function InboxPage({
  items,
  unread,
  onMarkRead,
  onMarkAllRead,
  active,
  height,
  now = Date.now(),
}: InboxPageProps): JSX.Element {
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const visible = useMemo(() => groupInbox(filterInbox(items, filter)), [items, filter]);
  const index = Math.min(selected, Math.max(0, visible.length - 1));
  const current = visible[index];
  const markGroupRead = (group: InboxGroup): void => {
    for (const item of group.items) if (item.readAt === null) onMarkRead(item.id);
  };

  useInput(
    (input, key) => {
      if (key.upArrow) setSelected(Math.max(0, index - 1));
      else if (key.downArrow) setSelected(Math.min(visible.length - 1, index + 1));
      else if (key.pageDown) setSelected(Math.min(visible.length - 1, index + 10));
      else if (key.pageUp) setSelected(Math.max(0, index - 10));
      else if (key.return && current) {
        setExpanded(expanded === current.latest.id ? null : current.latest.id);
        markGroupRead(current);
      } else if (input === "r" && current) markGroupRead(current);
      else if (input === "R") onMarkAllRead();
      else if (input === "f") {
        setFilter(FILTERS[(FILTERS.indexOf(filter) + 1) % FILTERS.length]!);
        setSelected(0);
      }
    },
    { isActive: active },
  );

  // Rows that fit: the frame, header and hint take ~6 lines.
  const rowsAvailable = Math.max(3, height - 6);
  const start = Math.max(0, Math.min(index - Math.floor(rowsAvailable / 2), visible.length - rowsAvailable));
  const window = visible.slice(start, start + rowsAvailable);

  return (
    <Box flexDirection="column" borderStyle={roundBorder()} borderColor={theme.fg.muted} paddingX={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text color={theme.accent.primary} bold>
            {`${theme.symbols.inbox} Inbox`}
          </Text>
          <Text color={theme.fg.muted}>{"  "}</Text>
          {unread > 0 ? (
            <Text color={theme.accent.warning} bold>{`${unread} unread`}</Text>
          ) : (
            <Text color={theme.accent.success}>all caught up</Text>
          )}
        </Text>
        <Text color={theme.fg.muted}>
          showing <Text color={theme.fg.default}>{FILTER_LABEL[filter]}</Text> · {visible.length}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {visible.length === 0 ? (
          <Box flexDirection="column" paddingY={1}>
            <Text color={theme.fg.muted}>
              {filter === "all"
                ? "Nothing yet. Approvals, blocked calls, crashed agents and updates will show up here."
                : "Nothing matches this filter. Press f to change it."}
            </Text>
          </Box>
        ) : (
          window.map((group) => {
            const item = group.latest;
            const isSelected = item.id === current?.latest.id;
            const { glyph, color } = levelGlyph(item.level);
            const isUnread = group.unread > 0;
            return (
              <Box key={item.id} flexDirection="column">
                <Text wrap="truncate-end">
                  <Text color={isSelected ? theme.accent.primary : theme.fg.muted}>
                    {isSelected ? `${theme.symbols.cursor} ` : "  "}
                  </Text>
                  <Text color={isUnread ? theme.accent.primary : theme.fg.muted}>
                    {isUnread ? theme.symbols.activeDot : " "}
                  </Text>
                  <Text> </Text>
                  <Text color={color}>{glyph}</Text>
                  <Text> </Text>
                  <Text color={isUnread ? theme.fg.emphasis : theme.fg.default} bold={isUnread}>
                    {item.title}
                  </Text>
                  {group.items.length > 1 ? (
                    <Text color={theme.fg.muted}>{` ×${group.items.length}`}</Text>
                  ) : null}
                  <Text color={theme.fg.muted}>{`  ${relativeTime(item.createdAt, now)}`}</Text>
                </Text>
                {expanded === item.id || (isSelected && item.body.length > 0) ? (
                  <Text color={theme.fg.muted} wrap={expanded === item.id ? "wrap" : "truncate-end"}>
                    {`      ${item.body || "(no details)"}`}
                  </Text>
                ) : null}
              </Box>
            );
          })
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.fg.muted}>
          ↑↓ select · Enter details · r read · R read all · f filter · Esc back
        </Text>
      </Box>
    </Box>
  );
}
