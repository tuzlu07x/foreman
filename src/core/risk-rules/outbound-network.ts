import type { RiskRule } from './types.js'

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
  evaluate(req) {
    if (!req.targetTool) return null
    if (OUTBOUND_TOOLS.some((p) => p.test(req.targetTool!))) {
      return {
        points: 30,
        reason: `outbound network tool: ${req.targetTool}`,
      }
    }
    return null
  },
}
