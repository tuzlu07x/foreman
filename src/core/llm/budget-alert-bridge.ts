import { ulid } from 'ulid'
import {
  bus as defaultBus,
  type EventBus,
  type ForemanEventMap,
  type Unsubscribe,
} from '../event-bus.js'
import type { NotificationService } from '../notification/notification-service.js'

// =============================================================================
// Budget-alert → OOB notification bridge (#233 / C10)
// =============================================================================
//
// Subscribes to `llm:budget-alert` and dispatches a `budget_alert` notification
// through the existing NotificationService. Sits at the same layer as
// `NotificationBridge` (approval flow) — pluggable and disposable so tests
// can opt in.
//
// One alert per (kind, billing window) is enforced at the emit side
// (`recordUsageAndCheckBudget`), so this bridge can be naïve.

export interface BudgetAlertBridgeDeps {
  bus?: EventBus<ForemanEventMap>
  notify: NotificationService
}

export class BudgetAlertBridge {
  private readonly bus: EventBus<ForemanEventMap>
  private readonly notify: NotificationService
  private unsubscribe: Unsubscribe | null = null

  constructor(deps: BudgetAlertBridgeDeps) {
    this.bus = deps.bus ?? defaultBus
    this.notify = deps.notify
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.bus.on('llm:budget-alert', (e) => {
      void this.dispatch(e)
    })
  }

  stop(): void {
    if (!this.unsubscribe) return
    this.unsubscribe()
    this.unsubscribe = null
  }

  private async dispatch(
    e: ForemanEventMap['llm:budget-alert'],
  ): Promise<void> {
    const { title, body } = formatBudgetAlert(e)
    try {
      await this.notify.send('budget_alert', {
        level: 'budget_alert',
        requestId: null,
        title,
        body,
        actions: [],
        agentBlocking: false,
      })
    } catch {
      // Best-effort: never let a notification failure crash the consumer.
    }
  }
}

/** Used by the bridge AND surfaced for the TUI toast (#233 acceptance). */
export function formatBudgetAlert(
  e: ForemanEventMap['llm:budget-alert'],
): { title: string; body: string } {
  const spent = `$${e.spentUsd.toFixed(2)}`
  const cap = `$${e.capUsd.toFixed(2)}`
  const pct = `${e.spentPct.toFixed(0)}%`
  const days = `${e.daysUntilReset} day${e.daysUntilReset === 1 ? '' : 's'}`
  if (e.kind === 'exhausted') {
    return {
      title: 'Foreman: LLM budget exhausted',
      body:
        `LLM spending hit ${spent} of ${cap} (${pct}). Smart features are paused ` +
        `until the budget resets in ${days}. Run \`foreman llm budget --set N\` to ` +
        `raise the cap, or wait for the reset.`,
    }
  }
  return {
    title: `Foreman: LLM budget ${pct} spent`,
    body:
      `LLM spending hit ${spent} of ${cap} (${pct}). Budget resets in ${days}. ` +
      `Smart features are still on; this is the heads-up before hitting the cap.`,
  }
}

// Re-export an id helper so audit consumers can deduplicate if needed.
export function newAlertId(): string {
  return `budget-alert-${ulid()}`
}
