import type { ApprovalRequest } from "../core/approval.js";
import type { ApprovalRecommendation } from "../core/org/review.js";

// =============================================================================
// Approval queue (#614)
// =============================================================================
//
// Several agents can wait on the user at once. The modal used to hold a
// single request: a second `approval:requested` replaced the first, which
// then sat invisible until its own timeout. The queue keeps every pending
// approval, ordered by deadline, and each decision names the request it is
// for, so a queue that changes underneath the user can never redirect a
// keypress to a different call.
//
// The TUI never times an approval out itself. The service that asked
// (the in-process bus service, or the requesting process for DB-backed
// approvals) owns the deadline and announces the outcome; the queue only
// hides items a little after their deadline in case that announcement is
// lost.

/** Deadline used for display when a request carries none. */
export const FALLBACK_DEADLINE_MS = 60_000;
/** How long past its deadline an unannounced item stays visible. */
export const EXPIRY_GRACE_MS = 5_000;

export interface QueuedApproval {
  request: ApprovalRequest;
  /** Absolute ms. */
  deadline: number;
  /** False when the request carried no deadline and `deadline` is only a
   *  display fallback. Such items wait for the outcome to be announced
   *  (the bridge's stale sweep covers requesters that died). */
  hasDeadline: boolean;
  receivedAt: number;
  /** Manager agents' advice (#623). Shown, never acted on. */
  recommendations: ApprovalRecommendation[];
}

export interface ApprovalQueueState {
  items: QueuedApproval[];
  /** requestId of the item on screen; null when the queue is empty. */
  selectedId: string | null;
}

export const EMPTY_QUEUE: ApprovalQueueState = { items: [], selectedId: null };

export function enqueueApproval(
  state: ApprovalQueueState,
  request: ApprovalRequest,
  now: number,
  recommendations: ApprovalRecommendation[] = [],
): ApprovalQueueState {
  if (state.items.some((i) => i.request.requestId === request.requestId)) return state;
  const item: QueuedApproval = {
    request,
    deadline: request.deadlineMs ?? now + FALLBACK_DEADLINE_MS,
    hasDeadline: request.deadlineMs !== undefined,
    receivedAt: now,
    recommendations,
  };
  const items = [...state.items, item].sort(
    (a, b) => a.deadline - b.deadline || a.receivedAt - b.receivedAt,
  );
  // Keep the user's place: a newly arrived approval never steals focus.
  return { items, selectedId: state.selectedId ?? request.requestId };
}

/** Attach a manager's recommendation to its approval (#623). It changes
 *  what is shown, never the deadline, the order or the selection. */
export function addRecommendation(
  state: ApprovalQueueState,
  rec: ApprovalRecommendation,
): ApprovalQueueState {
  const index = state.items.findIndex((i) => i.request.requestId === rec.approvalId);
  if (index === -1) return state;
  const item = state.items[index]!;
  if (item.recommendations.some((r) => r.managerRole === rec.managerRole)) return state;
  const items = [...state.items];
  items[index] = { ...item, recommendations: [...item.recommendations, rec] };
  return { ...state, items };
}

export function removeApproval(state: ApprovalQueueState, requestId: string): ApprovalQueueState {
  const index = state.items.findIndex((i) => i.request.requestId === requestId);
  if (index === -1) return state;
  const items = state.items.filter((_, i) => i !== index);
  if (state.selectedId !== requestId) return { items, selectedId: state.selectedId };
  // The one on screen went away: show the next one in line (or the
  // previous, if it was last).
  const next = items[index] ?? items[index - 1] ?? null;
  return { items, selectedId: next?.request.requestId ?? null };
}

export function expireApprovals(state: ApprovalQueueState, now: number): ApprovalQueueState {
  let next = state;
  for (const item of state.items) {
    if (item.hasDeadline && now > item.deadline + EXPIRY_GRACE_MS) {
      next = removeApproval(next, item.request.requestId);
    }
  }
  return next;
}

export function moveSelection(state: ApprovalQueueState, delta: number): ApprovalQueueState {
  if (state.items.length === 0) return state;
  const current = Math.max(0, selectedIndex(state));
  const index = (current + delta + state.items.length) % state.items.length;
  return { ...state, selectedId: state.items[index]!.request.requestId };
}

export function selectedIndex(state: ApprovalQueueState): number {
  return state.items.findIndex((i) => i.request.requestId === state.selectedId);
}

export function selectedApproval(state: ApprovalQueueState): QueuedApproval | null {
  return state.items[selectedIndex(state)] ?? null;
}

export function secondsLeft(item: QueuedApproval, now: number): number {
  return Math.max(0, Math.ceil((item.deadline - now) / 1000));
}
