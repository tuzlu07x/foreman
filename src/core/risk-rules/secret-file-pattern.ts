import { extractPath, type RiskRule } from './types.js'

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
  evaluate(req) {
    const path = extractPath(req.args)
    if (!path) return null
    if (PATTERNS.some((p) => p.test(path))) {
      return { points: 50, reason: `path looks like a credential: ${path}` }
    }
    return null
  },
}
