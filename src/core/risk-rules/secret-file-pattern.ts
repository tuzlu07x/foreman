import { extractPath, type RiskFactor, type RiskRule } from './types.js'

const PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.|$)/i,
  /\.key$/i,
  /\.pem$/i,
  /id_rsa(\.pub)?$/i,
  /id_ed25519(\.pub)?$/i,
  /\.npmrc$/i,
  /\.aws\/credentials/i,
  /\.ssh\/[^/]+$/i,
]

export const secretFilePattern: RiskRule = {
  name: 'secret_file_pattern',
  category: 'secret',
  evaluate(req): RiskFactor[] {
    const path = extractPath(req.args)
    if (!path) return []
    const matched = PATTERNS.find((p) => p.test(path))
    if (!matched) return []
    return [
      {
        rule: 'secret_file_pattern',
        category: 'secret',
        points: 50,
        reason: `path looks like a credential: ${path}`,
        evidence: path,
      },
    ]
  },
}
