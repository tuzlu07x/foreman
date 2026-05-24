import type { SessionResolutionPayload } from './event-bus.js'
import type { HaltReason } from './session.js'

// =============================================================================
// Session resolution templates (#527)
// =============================================================================
//
// When the loop detector (or another recoverable halt) fires, Foreman asks
// the user "what do you want to do?" with a short option set tailored to
// the halt reason. This module owns the keyed-by-reason library so the
// UX stays consistent across surfaces (Telegram inline buttons today,
// TUI modal + Discord/Slack later).
//
// Why a separate module:
//   - Templates are pure data; sessions.ts already busy with state machine
//     plumbing.
//   - The library lives close to where the human-language strings get
//     edited (UX iteration touches this file, not state code).
//   - Tests can import the templates directly without spinning up a
//     SessionManager.

export interface ResolutionOption {
  id: string
  label: string
  payload: SessionResolutionPayload
}

export interface ResolutionTemplate {
  /** Whether Foreman should ask the user at all for this halt reason.
   *  `false` for manual halts (user explicitly halted, no resolution
   *  to offer). */
  interactive: boolean
  options: ResolutionOption[]
}

const NO_RESOLUTION: ResolutionTemplate = { interactive: false, options: [] }

const LOOP_DETECTION_TEMPLATE: ResolutionTemplate = {
  interactive: true,
  options: [
    {
      id: 'opt-skip',
      label: 'Skip — decide later',
      payload: {
        kind: 'skip',
        note: 'user: skip the disputed item, continue with the rest',
      },
    },
    {
      id: 'opt-delegate-pm',
      label: 'Let PM (OpenClaw) decide',
      payload: {
        kind: 'delegate-to',
        target: 'openclaw',
        note: 'user: OpenClaw makes the call on the disputed item',
      },
    },
    {
      id: 'opt-user-decide',
      label: "I'll decide — ask me",
      payload: {
        kind: 'user-input-needed',
        prompt: 'How should the agents resolve this? (free-form text)',
      },
    },
    {
      id: 'opt-abandon',
      label: 'Abandon session',
      payload: { kind: 'abandon' },
    },
  ],
}

// Turn / token limit halts intentionally stay non-interactive in v0.1.1.
// Issue scope (#527) calls this out explicitly: "Turn/token halts usually
// mean 'user picked a too-small budget' and resume is just 'bump it +
// continue'". Loop halts are the high-value disambiguation case; budget
// halts get the standard "⚠ halted" session lifecycle push instead of an
// interactive prompt. The bump-budget option lands in v0.2 once the
// per-session token-cap UI exists; the structure below is left commented
// out as the seam.
//
//   const BUDGET_HALT_TEMPLATE: ResolutionTemplate = {
//     interactive: true,
//     options: [
//       { id: 'opt-bump-budget', label: '+50K tokens, continue',
//         payload: { kind: 'skip', note: 'user: extended the budget' } },
//       { id: 'opt-abandon', label: 'Abandon session',
//         payload: { kind: 'abandon' } },
//     ],
//   }

/** Look up the resolution template for a halt reason. Unknown reasons +
 *  manual halts fall through to `NO_RESOLUTION` so SessionManager skips
 *  the prompt entirely (no buttons, no timeout, the halt stays a halt). */
export function templateForHaltReason(reason: HaltReason): ResolutionTemplate {
  switch (reason) {
    case 'loop_detection':
      return LOOP_DETECTION_TEMPLATE
    case 'turn_limit':
    case 'token_limit':
      // v0.1.1 — no interactive resume for budget halts; the standard
      // session lifecycle push ("⚠ halted") is the user-facing surface.
      return NO_RESOLUTION
    case 'manual':
      return NO_RESOLUTION
    default:
      return NO_RESOLUTION
  }
}

/** Pure helper for the bridge: looks up an option by id in a template.
 *  Returns null when the id is unknown so the agent-relayed callback
 *  can surface "Unknown resolution option" instead of inventing a
 *  payload. */
export function findOption(
  template: ResolutionTemplate,
  optionId: string,
): ResolutionOption | null {
  return template.options.find((o) => o.id === optionId) ?? null
}

/** Templated context summary fallback when no LLM is available — keyed
 *  by halt reason + participants. The LLM-driven path overrides this
 *  with a richer narrative; the fallback keeps the prompt usable even
 *  when orchestrator_chat is off. */
export function fallbackContextSummary(
  reason: HaltReason,
  participants: string[],
): string {
  const names = participants.length > 0 ? participants.join(' + ') : 'session'
  switch (reason) {
    case 'loop_detection':
      return `${names} kept exchanging similar messages without progress — Foreman halted the session to ask you which way to break the loop.`
    case 'turn_limit':
      return `${names} reached the session turn cap. Pick how to continue.`
    case 'token_limit':
      return `${names} reached the session token cap. Pick how to continue.`
    case 'manual':
      return `${names} was halted manually. Pick how to proceed.`
    default:
      return `${names} halted (${reason}). Pick how to proceed.`
  }
}
