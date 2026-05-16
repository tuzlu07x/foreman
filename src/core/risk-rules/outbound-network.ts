import type { RiskFactor, RiskRule } from './types.js'

const OUTBOUND_TOOLS: RegExp[] = [
  /^fetch$/i,
  /^http(_|s_|s$|$)/i,
  /^wget$/i,
  /^curl$/i,
  /^request$/i,
  /^send_email$/i,
  /^post_webhook$/i,
]

export const outboundNetwork: RiskRule = {
  name: 'outbound_network',
  category: 'network',
  evaluate(req): RiskFactor[] {
    if (!req.targetTool) return []
    if (!OUTBOUND_TOOLS.some((p) => p.test(req.targetTool!))) return []
    return [
      {
        rule: 'outbound_network',
        category: 'network',
        points: 30,
        reason: `outbound network tool: ${req.targetTool}`,
        evidence: req.targetTool,
      },
    ]
  },
}
