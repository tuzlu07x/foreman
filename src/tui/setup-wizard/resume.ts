import {
  markUncompleted,
  sanitizeSession,
  type SessionCatalog,
  type SetupState,
} from "../setup-state.js";
import type { AgentsPhase } from "./agents-logic.js";

export interface ResumePlan {
  /** Setup state to start from (session reconciled, steps maybe re-opened). */
  setup: SetupState;
  /** Agents phase to open on when the agents step was re-opened. */
  agentsPhase: AgentsPhase | null;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/**
 * Reconcile a resumed session with the live registry before anything can
 * act on it. Install derives removals from `agentsSelected` vs the live
 * registry, so a snapshot must never be the source of a removal: an agent
 * registered after the snapshot (another terminal, a half-finished install)
 * would otherwise be unregistered + uninstalled with no "Will remove" screen.
 *
 * - The selection becomes the snapshot's picks PLUS every live agent, so no
 *   removal can come from a snapshot. Agents the registry catalog no longer
 *   has are dropped (sanitizeSession with the catalog).
 * - If the live registry differs from the snapshot's baseline, the snapshot
 *   predates the baseline field, it had excluded a live agent (a removal the
 *   user asked for earlier), or a retired agent was dropped, the agents step
 *   is re-opened on its confirm screen so the user reviews the plan.
 *
 * Only runs between "agents done" and "install done": before, the picker
 * sets the selection anyway; after, nothing acts on it any more.
 */
export function planResume(
  setup: SetupState,
  liveRegistered: readonly string[],
  catalog: SessionCatalog,
): ResumePlan {
  const raw = setup.session;
  if (!raw) return { setup, agentsPhase: null };
  const session = sanitizeSession(raw, catalog);
  if (!session) {
    const next: SetupState = { ...setup };
    delete next.session;
    return { setup: next, agentsPhase: null };
  }
  const agentsDone = setup.completed.includes("agents");
  const installDone = setup.completed.includes("install");
  if (!agentsDone || installDone) {
    return { setup: { ...setup, session }, agentsPhase: null };
  }

  const selected = [
    ...session.agentsSelected,
    ...liveRegistered.filter((id) => !session.agentsSelected.includes(id)),
  ];
  const baseline = session.registeredAtSnapshot;
  const review =
    baseline === undefined ||
    !sameIds(baseline, liveRegistered) ||
    selected.length !== session.agentsSelected.length ||
    session.agentsSelected.length !== raw.agentsSelected.length;
  const reconciled: SetupState = {
    ...setup,
    session: { ...session, agentsSelected: selected },
  };
  if (!review) return { setup: reconciled, agentsPhase: null };
  return {
    setup: markUncompleted(reconciled, "agents"),
    agentsPhase: "confirm",
  };
}
