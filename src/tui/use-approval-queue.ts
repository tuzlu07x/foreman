import { useCallback, useEffect, useState } from "react";
import type { EventBus, ForemanEventMap } from "../core/event-bus.js";
import type { ApprovalRecommendation } from "../core/org/review.js";
import {
  addRecommendation,
  EMPTY_QUEUE,
  enqueueApproval,
  expireApprovals,
  moveSelection,
  removeApproval,
  selectedApproval,
  type ApprovalQueueState,
  type QueuedApproval,
} from "./approval-queue.js";

export interface ApprovalDecisionInput {
  decision: "allowed" | "denied";
  remember?: "allow" | "deny";
}

export interface ApprovalQueueHandle {
  state: ApprovalQueueState;
  current: QueuedApproval | null;
  now: number;
  /** Decide one specific request. Callers pass the id they displayed. */
  resolve: (requestId: string, decision: ApprovalDecisionInput) => void;
  move: (delta: number) => void;
}

export function useApprovalQueue(
  bus: EventBus<ForemanEventMap>,
  /** Approvals announced before this hook subscribed (the bridge's first
   *  poll runs before the TUI mounts). */
  alreadyPending?: () => Array<ForemanEventMap["approval:requested"]>,
  /** Recommendations recorded before an approval reached the queue (#623). */
  recommendationsFor?: (approvalId: string) => ApprovalRecommendation[],
): ApprovalQueueHandle {
  const [state, setState] = useState<ApprovalQueueState>(EMPTY_QUEUE);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const known = (id: string): ApprovalRecommendation[] => {
      try {
        return recommendationsFor?.(id) ?? [];
      } catch {
        return [];
      }
    };
    const backlog = alreadyPending?.() ?? [];
    if (backlog.length > 0) {
      setState((s) =>
        backlog.reduce((acc, req) => enqueueApproval(acc, req, Date.now(), known(req.requestId)), s),
      );
    }
    const offRequested = bus.on("approval:requested", (req) => {
      const recommendations = known(req.requestId);
      setState((s) => enqueueApproval(s, req, Date.now(), recommendations));
    });
    // Advice only: it changes what the approval screen shows, nothing else.
    const offRecommended = bus.on("approval:recommended", (rec) => {
      setState((s) => addRecommendation(s, rec));
    });
    // Every outcome, wherever it happened (this TUI, Telegram, a timeout
    // in the requesting process), removes exactly that request.
    const offResolved = bus.on("approval:resolved", (e) => {
      setState((s) => removeApproval(s, e.requestId));
    });
    return () => {
      offRequested();
      offRecommended();
      offResolved();
    };
    // `alreadyPending` and `recommendationsFor` are read once, at mount.
  }, [bus]);

  const hasItems = state.items.length > 0;
  useEffect(() => {
    if (!hasItems) return;
    const tick = setInterval(() => {
      const t = Date.now();
      setNow(t);
      setState((s) => expireApprovals(s, t));
    }, 1000);
    return () => clearInterval(tick);
  }, [hasItems]);

  const resolve = useCallback(
    (requestId: string, decision: ApprovalDecisionInput): void => {
      bus.emit("approval:resolved", {
        requestId,
        decision: decision.decision,
        ...(decision.remember ? { remember: decision.remember } : {}),
        resolvedBy: "user",
        via: "tui",
      });
    },
    [bus],
  );

  const move = useCallback((delta: number): void => {
    setState((s) => moveSelection(s, delta));
  }, []);

  return { state, current: selectedApproval(state), now, resolve, move };
}
