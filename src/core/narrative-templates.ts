import type { RiskAssessment, RiskCategory } from './risk-rules/types.js'

// =============================================================================
// Narrative templates for heuristic-only paths (#232 / C9)
// =============================================================================
//
// When the LLM doesn't run (disabled, budget exhausted, error, below
// threshold) the modal still needs prose. Templates here produce honest,
// non-misleading copy: never pretend to know intent, never claim contextual
// insight we don't have. The footer always tells the user how to get the
// richer report.

export type FallbackReason =
  | 'llm_disabled'
  | 'llm_budget_exhausted'
  | 'llm_failed_fallback'
  | 'below_threshold'
  | 'heuristic_only'

export interface Narrative {
  whatHappening: string
  thingsToCheck: string[]
  recommendation: 'allow' | 'ask' | 'deny'
}

const CATEGORY_LABEL: Record<RiskCategory, string> = {
  secret: 'a credential / secret file',
  shell: 'a shell command',
  network: 'an outbound network call',
  injection: 'a possible prompt-injection pattern',
  loop: 'a loop / session-level anomaly',
  structural: 'a structural anomaly (unusual cross-agent pattern)',
}

const FOOTERS: Record<FallbackReason, string> = {
  llm_disabled:
    'Smart analysis is off. Run `foreman llm enable` for contextual threat assessment.',
  llm_budget_exhausted:
    'Smart analysis is paused (monthly LLM budget exhausted). Resets on the next cycle.',
  llm_failed_fallback:
    'Smart analysis temporarily unavailable (provider error). Heuristic factors shown below.',
  below_threshold:
    'Smart analysis skipped (score below threshold). The heuristic-only summary is below.',
  heuristic_only:
    'Heuristic-only summary. Run `foreman llm enable` for contextual reports.',
}

const FOREMAN_RECS: Record<'low' | 'medium' | 'high' | 'critical', 'allow' | 'ask' | 'deny'> = {
  low: 'allow',
  medium: 'ask',
  high: 'ask',
  critical: 'ask',
}

// =============================================================================
// Narrative builder — heuristic-derived, never makes up context
// =============================================================================

export function templateNarrative(
  assessment: RiskAssessment,
  reason: FallbackReason,
): Narrative {
  const categories = groupCategories(assessment.factors)
  const topFactors = topFactorsByPoints(assessment.factors, 3)

  // Build the "what's happening" paragraph from factor categories.
  let whatHappening: string
  if (categories.length === 0) {
    whatHappening =
      'No specific risk factors fired — policy asked for explicit approval. ' +
      FOOTERS[reason]
  } else {
    const flagged = categories
      .slice(0, 3)
      .map((c) => CATEGORY_LABEL[c])
      .join(', ')
    whatHappening =
      `Heuristic detection flagged ${flagged} ` +
      `(total ${assessment.totalScore}/100, bucket: ${assessment.bucket}). ` +
      FOOTERS[reason]
  }

  // "Things to check" — derived from the top factors. Honest about uncertainty.
  const thingsToCheck = buildChecklist(topFactors, assessment.bucket)

  // Recommendation mirrors the assessment's bucket since we have no LLM input.
  const recommendation = FOREMAN_RECS[assessment.bucket]

  return { whatHappening, thingsToCheck, recommendation }
}

// =============================================================================
// Helpers
// =============================================================================

function groupCategories(
  factors: readonly RiskAssessment['factors'][number][],
): RiskCategory[] {
  const seen = new Set<RiskCategory>()
  // Order = first-seen ordering. Caller can sort by points if it matters.
  for (const f of factors) {
    if (f.points <= 0) continue // safe-list negatives don't show as "flagged"
    if (!seen.has(f.category)) seen.add(f.category)
  }
  return [...seen]
}

function topFactorsByPoints(
  factors: readonly RiskAssessment['factors'][number][],
  limit: number,
): RiskAssessment['factors'][number][] {
  return [...factors]
    .filter((f) => f.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, limit)
}

function buildChecklist(
  topFactors: readonly RiskAssessment['factors'][number][],
  bucket: 'low' | 'medium' | 'high' | 'critical',
): string[] {
  if (topFactors.length === 0) {
    return ['No specific signals — review the request manually before approving.']
  }

  // First bullet: the strongest factor's reason (verbatim).
  const bullets: string[] = [`Strongest signal: ${topFactors[0]!.reason}`]

  // Add general "did you initiate this" prompt for high/critical.
  if (bucket === 'high' || bucket === 'critical') {
    bullets.push('Did you actually initiate this action just now?')
  }

  // Category-specific advisories — from the top few factors.
  const categories = new Set(topFactors.map((f) => f.category))
  if (categories.has('secret')) {
    bullets.push('If the path is a real secret, denying is safer.')
  }
  if (categories.has('shell')) {
    bullets.push('Read the command line carefully before approving.')
  }
  if (categories.has('network')) {
    bullets.push('Where is this connecting to? Is it a domain you recognise?')
  }
  if (categories.has('injection')) {
    bullets.push(
      'The args look like they include external instructions — is that expected?',
    )
  }
  if (categories.has('loop')) {
    bullets.push('Consider halting the session if this looks like a runaway loop.')
  }

  return bullets.slice(0, 5) // cap at 5 to keep the modal readable
}
