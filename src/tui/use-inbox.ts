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
    const next = inbox.list({ limit: LIST_LIMIT });
    // Keep the same array when nothing changed, so the 3 s refresh doesn't
    // re-render the whole screen.
    setItems((prev) => (sameItems(prev, next) ? prev : next));
    setUnread(inbox.unreadCount());
  }, [inbox]);

  useEffect(() => {
    if (!inbox) return;
    const offAdded = bus.on("inbox:added", (e) => {
      refresh();
      if (e.item.level !== "info" && e.item.readAt === null) setToast(e.item);
    });
    const offRead = bus.on("inbox:read", refresh);
    // An answered approval's "Approval needed" toast has nothing left to say.
    const offResolved = bus.on("approval:resolved", (e) => {
      setToast((t) => (t?.dedupeKey === `approval:${e.requestId}:requested` ? null : t));
    });
    // Another process (`foreman inbox read`) can change read state too.
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      offAdded();
      offRead();
      offResolved();
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

function sameItems(a: InboxItem[], b: InboxItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.readAt !== y.readAt || x.title !== y.title || x.level !== y.level) return false;
  }
  return true;
}
