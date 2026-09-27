import { useCallback, useEffect, useState } from "react";
import type { EventBus, ForemanEventMap } from "../core/event-bus.js";
import type { InboxService } from "../core/inbox.js";
import type { InboxItem } from "../db/schema.js";

const REFRESH_MS = 3_000;
const TOAST_MS = 8_000;
const LIST_LIMIT = 200;

export interface InboxHandle {
  items: InboxItem[];
  unread: number;
  /** Latest warning/critical item that arrived while the TUI was open. */
  toast: InboxItem | null;
  markRead: (id: string) => void;
  markAllRead: () => number;
  dismissToast: () => void;
}

export function useInbox(
  inbox: InboxService | undefined,
  bus: EventBus<ForemanEventMap>,
): InboxHandle {
  const [items, setItems] = useState<InboxItem[]>(() => inbox?.list({ limit: LIST_LIMIT }) ?? []);
  const [unread, setUnread] = useState(() => inbox?.unreadCount() ?? 0);
  const [toast, setToast] = useState<InboxItem | null>(null);

  const refresh = useCallback((): void => {
    if (!inbox) return;
    setItems(inbox.list({ limit: LIST_LIMIT }));
    setUnread(inbox.unreadCount());
  }, [inbox]);

  useEffect(() => {
    if (!inbox) return;
    const offAdded = bus.on("inbox:added", (e) => {
      refresh();
      if (e.item.level !== "info" && e.item.readAt === null) setToast(e.item);
    });
    const offRead = bus.on("inbox:read", refresh);
    // Another process (`foreman inbox read`) can change read state too.
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      offAdded();
      offRead();
      clearInterval(timer);
    };
  }, [inbox, bus, refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  const markRead = useCallback(
    (id: string): void => {
      inbox?.markRead(id);
      refresh();
    },
    [inbox, refresh],
  );
  const markAllRead = useCallback((): number => {
    const n = inbox?.markAllRead() ?? 0;
    refresh();
    setToast(null);
    return n;
  }, [inbox, refresh]);
  const dismissToast = useCallback(() => setToast(null), []);

  return { items, unread, toast, markRead, markAllRead, dismissToast };
}
