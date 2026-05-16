import type { RiskFactor, RiskRule } from './types.js'

const SHELL_TOOLS = new Set([
  'shell_exec',
  'run_command',
  'run_shell',
  'execute',
  'bash',
  'sh',
  'zsh',
  'exec',
])

export const shellExec: RiskRule = {
  name: 'shell_exec',
  category: 'shell',
  evaluate(req): RiskFactor[] {
    if (!req.targetTool) return []
    const lower = req.targetTool.toLowerCase()
    if (!SHELL_TOOLS.has(lower)) return []
    return [
      {
        rule: 'shell_exec',
        category: 'shell',
        points: 40,
        reason: `shell execution: ${req.targetTool}`,
        evidence: req.targetTool,
      },
    ]
  },
}
