import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'

// =============================================================================
// Notification runtime state (#235 / C11c)
// =============================================================================
//
// Persists silence + per-agent mute settings in `<configDir>/notify-state.json`
// so they survive `foreman start` restarts. Kept separate from `notify.yaml`
// (which is user-edited config) — this file is exclusively runtime state.

const NotifyStateSchema = z
  .object({
    /** Wall-clock ms; non-critical notifications are dropped before this time. */
    silencedUntil: z.number().nullable().default(null),
    /** sourceAgent ids that should NEVER trigger an OOB notification. */
    mutedAgents: z.array(z.string()).default([]),
  })
  .strict()

export type NotifyState = z.infer<typeof NotifyStateSchema>

export function defaultNotifyState(): NotifyState {
  return { silencedUntil: null, mutedAgents: [] }
}

export function loadNotifyState(path: string): NotifyState {
  if (!existsSync(path)) return defaultNotifyState()
  try {
    const raw = readFileSync(path, 'utf-8')
    if (raw.trim().length === 0) return defaultNotifyState()
    return NotifyStateSchema.parse(JSON.parse(raw))
  } catch {
    // Corrupt or unparseable file — fall back to defaults. Silence is
    // transient enough that we'd rather lose the window than crash boot.
    return defaultNotifyState()
  }
}

export function saveNotifyState(path: string, state: NotifyState): void {
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf-8')
}

// ============================================================================
// Pure helpers — used by NotificationBridge to decide whether to dispatch
// ============================================================================

/** True when silence is active right now. */
export function isSilenced(state: NotifyState, now = Date.now()): boolean {
  return state.silencedUntil !== null && state.silencedUntil > now
}

/** True when this source agent should be skipped entirely. */
export function isAgentMuted(state: NotifyState, sourceAgent: string): boolean {
  return state.mutedAgents.includes(sourceAgent)
}

// ============================================================================
// Duration parsing — accepts "30m", "4h", "2d" (no day-of-week / cron expr)
// ============================================================================

const DURATION_RE = /^(\d+)(m|h|d)$/

/** Returns the ms equivalent or null if the input is unparseable. */
export function parseDuration(input: string): number | null {
  const m = input.trim().toLowerCase().match(DURATION_RE)
  if (!m) return null
  const value = Number(m[1])
  const unit = m[2]
  if (!Number.isFinite(value) || value <= 0) return null
  if (unit === 'm') return value * 60_000
  if (unit === 'h') return value * 3_600_000
  if (unit === 'd') return value * 86_400_000
  return null
}
