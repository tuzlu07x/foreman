import { templateNarrative, type FallbackReason, type Narrative } from './narrative-templates.js'
import type {
  LlmVerification,
  RiskAssessment,
  RiskBucket,
  RiskFactor,
  ThreatType,
} from './risk-rules/types.js'

// =============================================================================
// SecurityReport — the 3-layer modal payload (#232 / C9)
// =============================================================================
//
// Built after the heuristic + LLM verifier have run. Persisted on the audit
// row so the user's modal experience can be reproduced from logs (compliance,
// debugging, future digest narratives). The shape is also what the modal
// component consumes; one struct → one rendering path.

export type ReportSeverity =
  | 'low'
  | 'medium'
  | 'high'
  | 'critical'
  | 'likely_legitimate'
  | 'uncertain'

export type ReportIcon = '🟢' | '🟡' | '🟠' | '🔴'

export type ReportSource =
  | 'heuristic_only'
  | 'llm_verified'
  | 'llm_failed_fallback'
  | 'llm_disabled'
  | 'llm_budget_exhausted'

export interface ReportVerdict {
  severity: ReportSeverity
  /** 0–1. Heuristic-only reports use a confidence proxy based on bucket. */
  confidence: number
  icon: ReportIcon
  /** Screen-reader-friendly label e.g. "LIKELY THREAT" / "UNCERTAIN". */
  label: string
  threatType: ThreatType | null
}

export interface ReportTechnical {
  factors: RiskFactor[]
  heuristicScore: number
  /** Total points the LLM verdict added/subtracted; null when LLM didn't run. */
  llmAdjustment: number | null
  finalScore: number
  bucket: RiskBucket
}

export interface SecurityReport {
  oneLineSummary: string
  verdict: ReportVerdict
  narrative: Narrative
  technical: ReportTechnical
  source: ReportSource
  reportLatencyMs: number
}

// =============================================================================
// generateReport — main entry
// =============================================================================

export interface ReportInput {
  sourceAgent: string
  /** Human-friendly persona note from the agent registry, if any. */
  sourceResponsibility?: string | null
  targetAgent?: string | null
  targetTool?: string | null
  args: unknown
  /** Heuristic-derived assessment; .llmVerification populated if C8 ran. */
  assessment: RiskAssessment
  /** Optional override; mostly for tests. Defaults to Date.now(). */
  now?: () => number
}

export function generateReport(input: ReportInput): SecurityReport {
  const start = (input.now ?? Date.now)()
  const llm = input.assessment.llmVerification

  // Path A: LLM produced real output. Use its narrative + verdict.
  if (llm && !llm.skipped) {
    const verdict = verdictFromLlm(llm)
    const narrative: Narrative = {
      whatHappening: llm.explanation_long,
      thingsToCheck:
        llm.user_should_check.length > 0
          ? llm.user_should_check
          : ['No specific items flagged.'],
      recommendation: llm.recommended_action,
    }
    return {
      oneLineSummary: buildSummary(input),
      verdict,
      narrative,
      technical: technicalFromAssessment(input.assessment, llm),
      source: 'llm_verified',
      reportLatencyMs: (input.now ?? Date.now)() - start,
    }
  }

  // Path B: heuristic-only. Map skipped reason → ReportSource so the modal
  // can render an honest footer.
  const source = sourceFromSkipped(llm?.skipped)
  const verdict = verdictFromHeuristic(input.assessment)
  return {
    oneLineSummary: buildSummary(input),
    verdict,
    narrative: templateNarrative(
      input.assessment,
      sourceToFallbackReason(source),
    ),
    technical: technicalFromAssessment(input.assessment, null),
    source,
    reportLatencyMs: (input.now ?? Date.now)() - start,
  }
}

// =============================================================================
// Verdict builders
// =============================================================================

function verdictFromLlm(llm: LlmVerification): ReportVerdict {
  // Map LLM output → severity buckets the modal renders. Confidence < 0.7
  // becomes "uncertain" regardless of the model's recommendation, so the
  // user knows to read carefully.
  if (llm.confidence < 0.7) {
    return {
      severity: 'uncertain',
      confidence: llm.confidence,
      icon: '🟠',
      label: `UNCERTAIN — your judgment required (confidence ${pct(llm.confidence)}%)`,
      threatType: llm.threat_type,
    }
  }
  if (!llm.is_real_threat) {
    return {
      severity: 'likely_legitimate',
      confidence: llm.confidence,
      icon: '🟡',
      label: `LIKELY LEGITIMATE (confidence ${pct(llm.confidence)}%)`,
      threatType: llm.threat_type,
    }
  }
  // Real threat — use the recommendation to pick severity.
  if (llm.recommended_action === 'deny') {
    return {
      severity: 'critical',
      confidence: llm.confidence,
      icon: '🔴',
      label: `LIKELY THREAT — ${humanThreatType(llm.threat_type)} (confidence ${pct(llm.confidence)}%)`,
      threatType: llm.threat_type,
    }
  }
  return {
    severity: 'high',
    confidence: llm.confidence,
    icon: '🟠',
    label: `RISKY — ${humanThreatType(llm.threat_type)} (confidence ${pct(llm.confidence)}%)`,
    threatType: llm.threat_type,
  }
}

function verdictFromHeuristic(assessment: RiskAssessment): ReportVerdict {
  const bucket = assessment.bucket
  const icon: ReportIcon =
    bucket === 'critical' ? '🔴' : bucket === 'high' ? '🟠' : bucket === 'medium' ? '🟡' : '🟢'
  const label =
    bucket === 'critical'
      ? 'RISKY CALL — CRITICAL'
      : bucket === 'high'
        ? 'RISKY CALL — HIGH'
        : bucket === 'medium'
          ? 'POSSIBLE RISK — MEDIUM'
          : 'LOW RISK'
  // Confidence proxy: 0.5 baseline (we don't have model input), nudged up
  // slightly with score so a 90-point heuristic doesn't render with the
  // same confidence as a 30-point one.
  const confidence = Math.min(0.85, 0.4 + assessment.totalScore / 200)
  return {
    severity: bucket,
    confidence,
    icon,
    label,
    threatType: null,
  }
}

function technicalFromAssessment(
  assessment: RiskAssessment,
  llm: LlmVerification | null,
): ReportTechnical {
  const heuristicScore =
    llm && !llm.skipped
      ? assessment.totalScore - llm.additional_risk_score
      : assessment.totalScore
  return {
    factors: [...assessment.factors],
    heuristicScore,
    llmAdjustment: llm && !llm.skipped ? llm.additional_risk_score : null,
    finalScore: assessment.totalScore,
    bucket: assessment.bucket,
  }
}

// =============================================================================
// One-line summary
// =============================================================================

function buildSummary(input: ReportInput): string {
  const responsibility = input.sourceResponsibility
    ? ` [${input.sourceResponsibility}]`
    : ''
  const tool = input.targetTool ?? '(no tool)'
  const argSnippet = renderArgSnippet(input.args)
  if (input.targetAgent) {
    return `${input.sourceAgent}${responsibility} wants ${input.targetAgent} to ${tool}${argSnippet}`
  }
  return `${input.sourceAgent}${responsibility} wants to ${tool}${argSnippet}`
}

function renderArgSnippet(args: unknown): string {
  if (args === null || args === undefined) return ''
  if (typeof args === 'string') return ` (${truncate(args, 60)})`
  if (typeof args !== 'object') return ` (${JSON.stringify(args)})`
  const obj = args as Record<string, unknown>
  if (typeof obj.path === 'string') return ` ${truncate(obj.path as string, 60)}`
  if (typeof obj.cmd === 'string') return `: ${truncate(obj.cmd, 60)}`
  if (typeof obj.command === 'string') return `: ${truncate(obj.command, 60)}`
  if (typeof obj.url === 'string') return ` (${truncate(obj.url, 60)})`
  return ''
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

// =============================================================================
// Reason / source mapping
// =============================================================================

function sourceFromSkipped(
  skipped: LlmVerification['skipped'] | undefined,
): ReportSource {
  switch (skipped) {
    case 'feature_disabled':
      return 'llm_disabled'
    case 'budget_exhausted':
      return 'llm_budget_exhausted'
    case 'llm_error':
      return 'llm_failed_fallback'
    case 'below_threshold':
      return 'heuristic_only'
    default:
      return 'heuristic_only'
  }
}

function sourceToFallbackReason(source: ReportSource): FallbackReason {
  switch (source) {
    case 'llm_disabled':
      return 'llm_disabled'
    case 'llm_budget_exhausted':
      return 'llm_budget_exhausted'
    case 'llm_failed_fallback':
      return 'llm_failed_fallback'
    case 'heuristic_only':
      return 'below_threshold'
    case 'llm_verified':
      return 'heuristic_only' // unreachable in practice — Path A doesn't call this
  }
}

function pct(confidence: number): number {
  return Math.round(confidence * 100)
}

function humanThreatType(t: ThreatType): string {
  switch (t) {
    case 'prompt_injection':
      return 'Prompt Injection'
    case 'data_exfil':
      return 'Data Exfiltration'
    case 'privilege_escalation':
      return 'Privilege Escalation'
    case 'credential_theft':
      return 'Credential Theft'
    case 'loop_attack':
      return 'Loop Attack'
    case 'social_engineering':
      return 'Social Engineering'
    case 'false_positive':
      return 'False Positive'
    case 'user_initiated_legitimate':
      return 'User-Initiated'
  }
}
