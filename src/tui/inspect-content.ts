import type { ApprovalRequest } from '../core/approval.js'
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

export function buildInspectLines(input: InspectInput): InspectLine[] {
  const { request, recentRequests } = input
  const out: InspectLine[] = []

  out.push({ text: 'Request inspector', bold: true, color: 'primary' })
  out.push({ text: `  id   ${request.requestId}`, color: 'muted' })
  out.push({ text: `  risk ${request.riskScore}/100`, color: 'muted' })
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
  if (request.riskReasons.length === 0) {
    out.push({ text: '  (no flagged reasons)', color: 'muted' })
  } else {
    for (const reason of request.riskReasons) {
      out.push({ text: `  ⚠ ${reason}`, color: 'warning' })
      const prose = explain(reason)
      if (prose) out.push({ text: `      ${prose}`, color: 'muted' })
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

function prettyJson(req: ApprovalRequest): string {
  const payload = {
    requestId: req.requestId,
    sourceAgent: req.sourceAgent,
    targetAgent: req.targetAgent,
    targetTool: req.targetTool,
    args: req.args,
    riskScore: req.riskScore,
    riskReasons: req.riskReasons,
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
