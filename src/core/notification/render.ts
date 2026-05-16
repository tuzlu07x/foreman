import type { ForemanEventMap } from '../event-bus.js'
import type { RiskBucket, RiskFactor } from '../risk-rules/types.js'
import type { Notification, NotificationAction, NotificationLevel } from './types.js'

// =============================================================================
// Approval event → Notification mapping (#235 / C11a-2)
// =============================================================================
//
// Renders the `approval:requested` event payload into a Notification with a
// short title, factor-summarised body, and bucket-appropriate action set.
// Channel-specific styling lives in each channel's `send()` implementation —
// the renderer ships only plain text.

export function levelForBucket(bucket: RiskBucket): NotificationLevel {
  if (bucket === 'critical') return 'critical'
  if (bucket === 'high') return 'critical'
  if (bucket === 'medium') return 'warning'
  return 'info'
}

export function renderApprovalNotification(
  req: ForemanEventMap['approval:requested'],
): Omit<Notification, 'id'> {
  const level = levelForBucket(req.riskBucket)
  const title = formatTitle(req)
  const body = formatBody(req)
  const actions = buildActions(req.riskBucket, req.riskFactors)
  return {
    level,
    requestId: req.requestId,
    title,
    body,
    actions,
    agentBlocking: true,
  }
}

function formatTitle(req: ForemanEventMap['approval:requested']): string {
  const bucketTag = req.riskBucket.toUpperCase()
  const flow = req.targetAgent
    ? `${req.sourceAgent} → ${req.targetAgent}`
    : req.sourceAgent
  const tool = req.targetTool ?? '(no tool)'
  return `[${bucketTag}] ${flow} · ${tool}`
}

function formatBody(req: ForemanEventMap['approval:requested']): string {
  const lines: string[] = []
  lines.push(`Risk score: ${req.riskScore}/100 (${req.riskBucket})`)

  if (req.riskFactors.length === 0 && req.riskReasons.length === 0) {
    lines.push('')
    lines.push('(no specific factors — Foreman is asking because policy says ask)')
  } else if (req.riskFactors.length === 0) {
    lines.push('')
    lines.push('Reasons:')
    for (const r of req.riskReasons) lines.push(`  • ${r}`)
  } else {
    const grouped = groupByCategory(req.riskFactors)
    for (const [category, factors] of grouped) {
      const total = factors.reduce((s, f) => s + f.points, 0)
      const sign = total >= 0 ? '+' : ''
      lines.push('')
      lines.push(`${categoryLabel(category)} (${sign}${total} pts):`)
      for (const f of factors) {
        const fSign = f.points >= 0 ? '+' : ''
        lines.push(`  ${fSign}${f.points}  ${f.reason}`)
      }
    }
  }

  const args = renderArgs(req.args)
  if (args) {
    lines.push('')
    lines.push(`Args: ${args}`)
  }

  return lines.join('\n')
}

function buildActions(
  bucket: RiskBucket,
  factors: RiskFactor[],
): NotificationAction[] {
  // critical bucket gets the full ladder so a tap can also persist the choice
  // as a policy rule. Lower buckets get a slimmer set so the modal doesn't
  // look spammy for low-stakes asks.
  const hasInspect = bucket === 'critical' || bucket === 'high'
  const actions: NotificationAction[] = [
    { id: 'allow', label: 'Allow once', style: 'primary' },
    { id: 'deny', label: 'Deny', style: 'danger' },
  ]
  if (bucket === 'critical') {
    actions.push({ id: 'deny_always', label: 'Always deny', style: 'danger' })
  }
  if (hasInspect) {
    actions.push({ id: 'inspect', label: 'Inspect', style: 'neutral' })
  }
  // A loop factor surfaced via OOB benefits from an explicit "halt session"
  // option in the modal — but Telegram has no session-halt verb yet (C11b
  // territory). Documented as a known gap; deny remains the safe fallback.
  void factors
  return actions
}

function groupByCategory(
  factors: readonly RiskFactor[],
): Map<RiskFactor['category'], RiskFactor[]> {
  const out = new Map<RiskFactor['category'], RiskFactor[]>()
  for (const f of factors) {
    const existing = out.get(f.category)
    if (existing) existing.push(f)
    else out.set(f.category, [f])
  }
  return out
}

function categoryLabel(c: RiskFactor['category']): string {
  switch (c) {
    case 'secret':
      return 'Secret-related'
    case 'shell':
      return 'Shell command'
    case 'network':
      return 'Network outbound'
    case 'injection':
      return 'Prompt injection'
    case 'loop':
      return 'Loop / session anomaly'
    case 'structural':
      return 'Structural'
    default:
      return c
  }
}

function renderArgs(args: unknown): string {
  if (args === null || args === undefined) return ''
  try {
    const text = JSON.stringify(args)
    if (text.length <= 200) return text
    return `${text.slice(0, 197)}…`
  } catch {
    return String(args).slice(0, 200)
  }
}

// =============================================================================
// Channel updateMessage — "decision elsewhere" follow-ups
// =============================================================================

export function renderResolvedFooter(
  e: ForemanEventMap['approval:resolved'],
): string {
  const verb = e.decision === 'allowed' ? '✓ Allowed' : '✗ Denied'
  const source =
    e.resolvedBy === 'timeout'
      ? '(timeout default)'
      : '(resolved elsewhere)'
  return `${verb} ${source} at ${new Date().toISOString().slice(11, 19)}`
}
