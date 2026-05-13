import type { RiskRule } from './types.js'

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
  evaluate(req) {
    if (!req.targetTool) return null
    if (SHELL_TOOLS.has(req.targetTool.toLowerCase())) {
      return { points: 40, reason: `shell execution: ${req.targetTool}` }
    }
    return null
  },
}
