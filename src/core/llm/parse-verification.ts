import { z } from 'zod'
import type { ThreatType } from '../risk-rules/types.js'

// =============================================================================
// Strict parser for the LLM verification JSON (#231 / C8)
// =============================================================================
//
// The prompt asks the model for a specific JSON shape with exact field names
// and enum values. We Zod-validate; anything malformed falls through to the
// verifier's "skipped: llm_error" path so we degrade gracefully.

const ThreatTypeSchema = z.enum([
  'prompt_injection',
  'data_exfil',
  'privilege_escalation',
  'credential_theft',
  'loop_attack',
  'social_engineering',
  'false_positive',
  'user_initiated_legitimate',
])

const VerificationCoreSchema = z
  .object({
    is_real_threat: z.boolean(),
    threat_type: ThreatTypeSchema,
    confidence: z.number().min(0).max(1),
    explanation_short: z.string().max(120),
    explanation_long: z.string().min(1).max(800),
    recommended_action: z.enum(['allow', 'ask', 'deny']),
    additional_risk_score: z.number().min(-30).max(30),
    user_should_check: z.array(z.string()).max(8),
  })
  .strict()

export type VerificationCore = z.infer<typeof VerificationCoreSchema>

/** Strips a markdown fence (```json ... ```) if the model wrapped its output. */
function stripFence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  const firstNewline = trimmed.indexOf('\n')
  if (firstNewline === -1) return trimmed
  const body = trimmed.slice(firstNewline + 1)
  const fenceEnd = body.lastIndexOf('```')
  return (fenceEnd === -1 ? body : body.slice(0, fenceEnd)).trim()
}

export class VerificationParseError extends Error {
  constructor(message: string, public readonly raw: string) {
    super(message)
    this.name = 'VerificationParseError'
  }
}

export function parseVerification(rawText: string): VerificationCore {
  const candidate = stripFence(rawText)
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch (err) {
    throw new VerificationParseError(
      `LLM output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      rawText,
    )
  }
  const result = VerificationCoreSchema.safeParse(parsed)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue ? issue.path.join('.') : '(root)'
    const message = issue ? issue.message : 'unknown'
    throw new VerificationParseError(
      `LLM output failed schema validation at ${path}: ${message}`,
      rawText,
    )
  }
  return result.data
}

/** True when the parser would accept this text — for tests / dry-runs. */
export function looksLikeVerification(rawText: string): boolean {
  try {
    parseVerification(rawText)
    return true
  } catch {
    return false
  }
}

export { VerificationCoreSchema }
export type { ThreatType }
