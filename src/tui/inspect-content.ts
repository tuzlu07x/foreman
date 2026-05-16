import type { ApprovalRequest } from '../core/approval.js'
import type {
  RiskCategory,
  RiskFactor,
} from '../core/risk-rules/types.js'
import type { Request } from '../db/schema.js'
import { formatTime, targetLabel } from './format.js'
import { explain } from './reason-explanations.js'

export type LineColor = 'default' | 'muted' | 'warning' | 'primary' | 'success' | 'danger'

export interface InspectLine {
  text: string
  color?: LineColor
  bold?: boolean
  italic?: boolean
}

export interface InspectInput {
  request: ApprovalRequest
  recentRequests: Request[]
}

const CATEGORY_ORDER: RiskCategory[] = [
  'secret',
  'shell',
  'network',
  'injection',
  'loop',
  'structural',
]

const CATEGORY_LABELS: Record<RiskCategory, string> = {
  secret: 'Secret-related',
  shell: 'Shell execution',
  network: 'Network outbound',
  injection: 'Prompt injection',
  loop: 'Loop / anomaly',
  structural: 'Structural',
}

export function buildInspectLines(input: InspectInput): InspectLine[] {
  const { request, recentRequests } = input
  const out: InspectLine[] = []

  out.push({ text: 'Request inspector', bold: true, color: 'primary' })
  out.push({ text: `  id     ${request.requestId}`, color: 'muted' })
  out.push({
    text: `  risk   ${request.riskScore}/100${request.riskBucket ? ` · ${request.riskBucket}` : ''}`,
    color: 'muted',
  })
  out.push({ text: '' })

  out.push({ text: 'Request chain', bold: true })
  const chain = recentRequests
    .filter((r) => r.sourceAgent === request.sourceAgent)
    .slice(0, 5)
  if (chain.length === 0) {
    out.push({
      text: '  (no prior activity from this source)',
      color: 'muted',
    })
  } else {
    chain.forEach((r, i) => {
      out.push({
        text: `  ${i + 1}. [${formatTime(r.createdAt)}] ${targetLabel(r.sourceAgent, r.targetAgent)}`,
      })
      out.push({
        text: `       ${r.targetTool ?? '(no tool)'} → ${r.decision}`,
        color: 'muted',
      })
    })
  }
  out.push({ text: '' })

  out.push({ text: 'Suspicious signals', bold: true })
  const factors = request.riskFactors ?? []
  if (factors.length === 0 && request.riskReasons.length === 0) {
    out.push({ text: '  (no flagged reasons)', color: 'muted' })
  } else if (factors.length === 0) {
    // Backwards-compat: rows from before migration 0007 have reasons but no
    // factors. Render the flat list to stay legible.
    for (const reason of request.riskReasons) {
      out.push({ text: `  ⚠ ${reason}`, color: 'warning' })
      const prose = explain(reason)
      if (prose) out.push({ text: `      ${prose}`, color: 'muted' })
    }
  } else {
    for (const group of groupFactors(factors)) {
      const sign = group.totalPoints >= 0 ? '+' : ''
      out.push({
        text: `  ${CATEGORY_LABELS[group.category]} (${sign}${group.totalPoints} pts)`,
        color: 'warning',
        bold: true,
      })
      for (const f of group.factors) {
        const fSign = f.points >= 0 ? '+' : ''
        out.push({ text: `    ${fSign}${f.points}  ${f.reason}` })
        if (f.evidence) {
          out.push({ text: `         ↳ ${f.evidence}`, color: 'muted' })
        }
      }
    }
  }
  out.push({ text: '' })

  if (request.context) {
    out.push({ text: 'Context', bold: true })
    out.push({ text: `  "${request.context}"`, italic: true, color: 'muted' })
    out.push({ text: '' })
  }

  out.push({ text: 'Full request payload', bold: true })
  for (const line of prettyJson(request).split('\n')) {
    out.push({ text: `  ${line}`, color: 'muted' })
  }

  return out
}

interface FactorGroup {
  category: RiskCategory
  factors: RiskFactor[]
  totalPoints: number
}

function groupFactors(factors: RiskFactor[]): FactorGroup[] {
  const map = new Map<RiskCategory, RiskFactor[]>()
  for (const f of factors) {
    const existing = map.get(f.category) ?? []
    existing.push(f)
    map.set(f.category, existing)
  }
  const groups: FactorGroup[] = []
  for (const category of CATEGORY_ORDER) {
    const bucket = map.get(category)
    if (!bucket || bucket.length === 0) continue;
    groups.push({
      category,
      factors: bucket,
      totalPoints: bucket.reduce((s, f) => s + f.points, 0),
    })
  }
  return groups
}

function prettyJson(req: ApprovalRequest): string {
  const payload = {
    requestId: req.requestId,
    sourceAgent: req.sourceAgent,
    targetAgent: req.targetAgent,
    targetTool: req.targetTool,
    args: req.args,
    riskScore: req.riskScore,
    riskBucket: req.riskBucket,
    riskReasons: req.riskReasons,
    riskFactors: req.riskFactors,
    llmVerification: req.llmVerification,
    ...(req.context ? { context: req.context } : {}),
  }
  return JSON.stringify(payload, null, 2)
}

export function clampOffset(
  offset: number,
  totalLines: number,
  visibleLines: number,
): number {
  const max = Math.max(0, totalLines - visibleLines)
  return Math.max(0, Math.min(offset, max))
}
