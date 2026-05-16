import type { RiskFactor, RiskRule } from './types.js'

// =============================================================================
// PATH PATTERNS
// =============================================================================
//
// Regexes match against JSON.stringify(args), so they survive whatever key
// the agent picked for the path (path, file, filename, command, cmd, ...).
// Pre-compiled at module load — regex is hot path inside the mediator.
//
// Sources: gitleaks rules (MIT), GitHub secret-scanning docs, OWASP.

interface PathPattern {
  pattern: RegExp
  points: number
  reason: string
}

// Cloud + IaaS credentials (10)
const CLOUD_PATHS: PathPattern[] = [
  {
    pattern: /\.aws\/credentials\b/i,
    points: 70,
    reason: 'AWS credentials file (~/.aws/credentials)',
  },
  {
    pattern: /\.aws\/config\b(?!\w)/i,
    points: 40,
    reason: 'AWS CLI config (~/.aws/config — may hold profiles/tokens)',
  },
  {
    pattern: /\.azure\/credentials\b/i,
    points: 70,
    reason: 'Azure CLI credentials (~/.azure/credentials)',
  },
  {
    pattern: /\.azure\/clouds\.config\b/i,
    points: 40,
    reason: 'Azure CLI clouds config',
  },
  {
    pattern: /gcloud\/application_default_credentials\.json\b/i,
    points: 70,
    reason: 'GCP application default credentials',
  },
  {
    pattern: /gcloud\/credentials\.db\b/i,
    points: 70,
    reason: 'GCP gcloud credentials.db',
  },
  {
    pattern: /doctl\/config\.yaml\b/i,
    points: 60,
    reason: 'DigitalOcean doctl config',
  },
  {
    pattern: /\.kube\/config\b(?!\w)/i,
    points: 60,
    reason: 'Kubernetes kubeconfig (~/.kube/config)',
  },
  {
    pattern: /hcloud\/cli\.toml\b/i,
    points: 60,
    reason: 'Hetzner Cloud hcloud CLI config',
  },
  {
    pattern: /[-_]credentials\.json\b/i,
    points: 50,
    reason: 'k8s/cloud service-account credentials JSON',
  },
]

// SSH + Git auth (8)
const SSH_GIT_PATHS: PathPattern[] = [
  {
    pattern: /\.ssh\/id_rsa\b(?!\.pub)/i,
    points: 80,
    reason: 'SSH private key (~/.ssh/id_rsa)',
  },
  {
    pattern: /\.ssh\/id_ed25519\b(?!\.pub)/i,
    points: 80,
    reason: 'SSH private key (~/.ssh/id_ed25519)',
  },
  {
    pattern: /\.ssh\/id_ecdsa\b(?!\.pub)/i,
    points: 80,
    reason: 'SSH private key (~/.ssh/id_ecdsa)',
  },
  {
    pattern: /\.ssh\/id_dsa\b(?!\.pub)/i,
    points: 80,
    reason: 'SSH private key (~/.ssh/id_dsa)',
  },
  {
    pattern: /\.ssh\/[^/\s"]+\.pem\b/i,
    points: 70,
    reason: 'SSH PEM private key under ~/.ssh',
  },
  {
    pattern: /\.ssh\/known_hosts\b/i,
    points: 25,
    reason: 'SSH known_hosts (host fingerprints, not a secret but identity-revealing)',
  },
  {
    pattern: /(^|[/"\s])\.netrc\b/i,
    points: 70,
    reason: '~/.netrc (HTTP/FTP credentials)',
  },
  {
    pattern: /(^|[/"\s])\.git-credentials\b/i,
    points: 70,
    reason: '~/.git-credentials (Git HTTPS tokens)',
  },
]

// Environment + app config (12)
const ENV_CONFIG_PATHS: PathPattern[] = [
  {
    // .env, .env.local, .env.production — but NOT .envrc, NOT .env.example/.sample/.test
    pattern:
      /(^|[/"\s])\.env(?:\.(?!example\b|sample\b|test\b)[a-zA-Z0-9_-]+)?(?=[/"\s]|$)/i,
    points: 60,
    reason: '.env-style file (likely contains API keys / secrets)',
  },
  {
    pattern: /config\/secrets\.yml\b/i,
    points: 70,
    reason: 'Rails secrets.yml',
  },
  {
    pattern: /config\/master\.key\b/i,
    points: 80,
    reason: 'Rails master.key (decrypts credentials.yml.enc)',
  },
  {
    pattern: /credentials\.yml\.enc\b/i,
    points: 60,
    reason: 'Rails encrypted credentials (paired with master.key)',
  },
  {
    pattern: /(^|[/"\s])secrets?\.json\b/i,
    points: 60,
    reason: 'secrets.json / secret.json',
  },
  {
    pattern: /appsettings\.[A-Za-z]+\.json\b/i,
    points: 50,
    reason: '.NET environment-specific appsettings',
  },
  {
    pattern: /docker-compose\.override\.ya?ml\b/i,
    points: 40,
    reason: 'docker-compose override (often holds local secrets)',
  },
  {
    pattern: /local\.settings\.json\b/i,
    points: 60,
    reason: 'Azure Functions local.settings.json',
  },
  {
    pattern: /\.netlify\/state\.json\b/i,
    points: 50,
    reason: 'Netlify CLI state (auth token)',
  },
  {
    pattern: /\.vercel\/auth\.json\b/i,
    points: 60,
    reason: 'Vercel CLI auth token',
  },
  {
    pattern: /firebase\.json\b/i,
    points: 30,
    reason: 'firebase.json (may contain service account hints)',
  },
  {
    pattern: /service-account\.json\b/i,
    points: 70,
    reason: 'GCP service-account JSON',
  },
]

// Package manager auth (8)
const PACKAGE_MGR_PATHS: PathPattern[] = [
  {
    pattern: /(^|[/"\s])\.npmrc\b/i,
    points: 60,
    reason: '~/.npmrc (npm auth token)',
  },
  {
    pattern: /(^|[/"\s])\.yarnrc(?:\.yml)?\b/i,
    points: 60,
    reason: '~/.yarnrc / ~/.yarnrc.yml',
  },
  {
    pattern: /\.cargo\/credentials\.toml\b/i,
    points: 70,
    reason: 'Cargo (Rust) credentials.toml',
  },
  {
    pattern: /\.pip\/pip\.conf\b/i,
    points: 50,
    reason: 'pip config (may hold index auth)',
  },
  {
    pattern: /(^|[/"\s])\.pypirc\b/i,
    points: 60,
    reason: '~/.pypirc (PyPI upload tokens)',
  },
  {
    pattern: /\.gem\/credentials\b/i,
    points: 60,
    reason: 'RubyGems credentials',
  },
  {
    pattern: /composer\/auth\.json\b/i,
    points: 60,
    reason: 'Composer (PHP) auth.json',
  },
  {
    pattern: /\.docker\/config\.json\b/i,
    points: 60,
    reason: 'Docker registry auth config',
  },
]

// Password managers + system vaults (6)
const PASSWORD_MGR_PATHS: PathPattern[] = [
  {
    pattern: /\.config\/op(?:[/"\s]|$)/i,
    points: 70,
    reason: '1Password CLI state directory',
  },
  {
    pattern: /\.config\/[Bb]itwarden(?:[\s-]CLI)?(?:[/"\s]|$)/i,
    points: 70,
    reason: 'Bitwarden CLI state',
  },
  {
    pattern: /\.local\/share\/keyrings\/login\.keyring\b/i,
    points: 80,
    reason: 'GNOME login keyring',
  },
  {
    pattern: /Library\/Keychains\/[^/"\s]+\.keychain(?:-db)?\b/i,
    points: 80,
    reason: 'macOS keychain database',
  },
  {
    pattern: /(^|[/"\s])\.password-store(?:[/"\s]|$)/i,
    points: 80,
    reason: '`pass` password store',
  },
  {
    pattern: /\.config\/keepassxc(?:[/"\s]|$)/i,
    points: 60,
    reason: 'KeePassXC config directory',
  },
]

// Browser data (5)
const BROWSER_PATHS: PathPattern[] = [
  {
    pattern: /Chrome\/[^/"\s]+\/Login Data\b/i,
    points: 80,
    reason: 'Chrome saved passwords database',
  },
  {
    pattern: /google-chrome\/[^/"\s]+\/Login Data\b/i,
    points: 80,
    reason: 'Chrome (Linux) saved passwords database',
  },
  {
    pattern: /firefox\/[^/"\s]+\/logins\.json\b/i,
    points: 80,
    reason: 'Firefox saved logins',
  },
  {
    pattern: /Firefox\/Profiles\/[^/"\s]+\/key4\.db\b/i,
    points: 80,
    reason: 'Firefox key4.db (login encryption key)',
  },
  {
    pattern: /Cookies\.binarycookies\b/i,
    points: 60,
    reason: 'Browser cookies database',
  },
]

// Foreman + partner-agent state (6)
const FOREMAN_PARTNER_PATHS: PathPattern[] = [
  {
    pattern: /(^|[/"\s])identity\.key\b/i,
    points: 80,
    reason: 'Foreman identity.key (Ed25519 private key)',
  },
  {
    pattern: /(^|[/"\s])foreman\.db\b/i,
    points: 70,
    reason: 'Foreman SQLite (encrypted secret store + audit log)',
  },
  {
    pattern: /\.hermes\/\.env\b/i,
    points: 70,
    reason: 'Hermes agent .env',
  },
  {
    pattern: /\.openclaw\/openclaw\.json\b/i,
    points: 60,
    reason: 'OpenClaw config (may contain keys)',
  },
  {
    pattern: /\.codex\/auth\.json\b/i,
    points: 70,
    reason: 'Codex auth token',
  },
  {
    pattern: /\.zeroclaw\/config\.toml\b/i,
    points: 60,
    reason: 'ZeroClaw config',
  },
]

// Misc certs + encrypted stores (6)
const MISC_CERT_PATHS: PathPattern[] = [
  {
    pattern: /\.pfx\b/i,
    points: 70,
    reason: 'PFX certificate bundle (includes private key)',
  },
  {
    pattern: /\.p12\b/i,
    points: 70,
    reason: 'P12 / PKCS#12 certificate bundle',
  },
  {
    pattern: /(^|[/"\s])[^/"\s]+\.pem\b/i,
    points: 50,
    reason: 'PEM file (key or cert)',
  },
  {
    pattern: /(^|[/"\s])[^/"\s]+\.key\b/i,
    points: 40,
    reason: '.key file (likely cryptographic key)',
  },
  {
    pattern: /\.kdbx?\b/i,
    points: 80,
    reason: 'KeePass database',
  },
  {
    pattern: /\.gpg\b/i,
    points: 30,
    reason: 'GPG-encrypted file (sensitive even though encrypted)',
  },
]

const ALL_PATH_PATTERNS: PathPattern[] = [
  ...CLOUD_PATHS,
  ...SSH_GIT_PATHS,
  ...ENV_CONFIG_PATHS,
  ...PACKAGE_MGR_PATHS,
  ...PASSWORD_MGR_PATHS,
  ...BROWSER_PATHS,
  ...FOREMAN_PARTNER_PATHS,
  ...MISC_CERT_PATHS,
]

// =============================================================================
// CONTENT SHAPE PATTERNS — secret-shaped strings in args
// =============================================================================
//
// Match against the stringified args. Each fires its own factor so the inspect
// view shows which kind of secret is in flight. Fingerprints (`sk-…ab12`) are
// shown to the user — the full secret never reaches the modal/log.

interface ContentPattern {
  pattern: RegExp
  label: string
}

const CONTENT_PATTERNS: ContentPattern[] = [
  {
    pattern: /sk-ant-api03-[A-Za-z0-9_-]{50,}/,
    label: 'Anthropic API key',
  },
  {
    pattern: /sk-proj-[A-Za-z0-9_-]{40,}/,
    label: 'OpenAI project key',
  },
  {
    pattern: /sk-[A-Za-z0-9]{20,}/,
    label: 'OpenAI-style API key',
  },
  {
    pattern: /AKIA[0-9A-Z]{16}/,
    label: 'AWS access key ID',
  },
  {
    pattern: /aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{40}/i,
    label: 'AWS secret access key',
  },
  {
    pattern: /ghp_[A-Za-z0-9]{36}/,
    label: 'GitHub personal access token (classic)',
  },
  {
    pattern: /github_pat_[A-Za-z0-9_]{82}/,
    label: 'GitHub fine-grained PAT',
  },
  {
    pattern: /gho_[A-Za-z0-9]{36}/,
    label: 'GitHub OAuth token',
  },
  {
    pattern: /ghs_[A-Za-z0-9]{36}/,
    label: 'GitHub Apps installation token',
  },
  {
    pattern: /xoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24}/,
    label: 'Slack bot token',
  },
  {
    pattern: /xapp-[0-9]+-[A-Z0-9]+-[0-9]+-[A-Za-z0-9]{64}/,
    label: 'Slack app-level token',
  },
  {
    pattern: /(?<![\w-])[0-9]{8,}:[A-Z]{2}[A-Za-z0-9_-]{30,}/,
    label: 'Telegram bot token',
  },
  {
    // 3-part base64url. Header (eyJ...) is often as short as 17 chars after
    // eyJ for HS256 — keep the min low. Payload must also start with eyJ
    // (base64 of `{"`) so we're not matching random dotted strings.
    pattern: /\beyJ[A-Za-z0-9_=-]{10,}\.eyJ[A-Za-z0-9_=-]{10,}\.[A-Za-z0-9_=-]{20,}/,
    label: 'JWT (3-part)',
  },
  {
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    label: 'PEM-encoded private key',
  },
  {
    pattern: /\b(?:postgres|postgresql|mysql|mongodb|redis|amqp):\/\/[^\s:"]+:[^\s@"]+@/,
    label: 'Database URL with embedded credentials',
  },
  {
    // Real Google API keys are exactly 39 chars (AIza + 35). No trailing \b
    // because the next char in real-world payloads is usually alphanumeric
    // continuation of whatever encloses the key.
    pattern: /\bAIza[0-9A-Za-z_-]{35}/,
    label: 'Google API key',
  },
]

// =============================================================================
// SAFE-LIST — common files that look secret-adjacent but are docs/config
// =============================================================================
//
// Subtracts a small negative factor when a positive factor would otherwise
// fire — e.g. `.env.example` matches the `.env*` content but is a docs file,
// so the safe-list pulls the score back down.

interface SafePattern {
  pattern: RegExp
  reason: string
}

const SAFE_LIST_PATHS: SafePattern[] = [
  {
    pattern: /(^|[/"\s])\.envrc\b/i,
    reason: '`.envrc` is direnv config, not a secret file',
  },
  {
    pattern: /\.env\.example\b/i,
    reason: '`.env.example` is a docs template',
  },
  {
    pattern: /\.env\.sample\b/i,
    reason: '`.env.sample` is a docs template',
  },
  {
    pattern: /\.env\.test\b/i,
    reason: '`.env.test` is a test fixture',
  },
  {
    pattern: /(^|[/"\s])\.gitignore\b/i,
    reason: '`.gitignore` is a VCS metadata file',
  },
  {
    pattern: /(^|[/"\s])\.dockerignore\b/i,
    reason: '`.dockerignore` is build metadata',
  },
  {
    pattern: /package(?:-lock)?\.json\b/i,
    reason: '`package.json` / `package-lock.json` is npm metadata',
  },
  {
    pattern: /tsconfig(?:\.[a-zA-Z0-9_-]+)?\.json\b/i,
    reason: '`tsconfig*.json` is TypeScript config',
  },
  {
    pattern: /(^|[/"\s])README(?:\.[a-zA-Z]+)?\b/i,
    reason: 'README file',
  },
  {
    pattern: /(^|[/"\s])LICENSE\b/i,
    reason: 'LICENSE file',
  },
  {
    pattern: /(^|[/"\s])CHANGELOG\b/i,
    reason: 'CHANGELOG file',
  },
]

// =============================================================================
// Helpers
// =============================================================================

// Returns a redacted preview of a matched secret string for use in factor
// reasons / evidence — never leaks the full value to the modal or audit log.
export function shortFingerprint(s: string): string {
  if (s.length <= 8) return '••'
  if (s.length <= 16) return `${s.slice(0, 4)}…${s.slice(-2)}`
  return `${s.slice(0, 8)}…${s.slice(-4)}`
}

// =============================================================================
// Rule
// =============================================================================

export const secretPatternRule: RiskRule = {
  name: 'secret_pattern',
  category: 'secret',
  evaluate(req): RiskFactor[] {
    if (req.args === undefined || req.args === null) return []
    let argsText: string
    try {
      argsText = JSON.stringify(req.args)
    } catch {
      // Circular reference or otherwise unstringifiable — give up rather
      // than crash the mediator.
      return []
    }
    if (argsText.length === 0) return []

    const factors: RiskFactor[] = []

    // Path patterns: first match wins to avoid double-counting a single path
    // that happens to brush several patterns at once.
    for (const { pattern, points, reason } of ALL_PATH_PATTERNS) {
      const match = pattern.exec(argsText)
      if (match) {
        factors.push({
          rule: 'secret_path',
          category: 'secret',
          points,
          reason,
          evidence: match[0],
        })
        break
      }
    }

    // Content patterns: each distinct shape fires its own factor.
    const seenLabels = new Set<string>()
    for (const { pattern, label } of CONTENT_PATTERNS) {
      if (seenLabels.has(label)) continue
      const m = pattern.exec(argsText)
      if (m) {
        seenLabels.add(label)
        factors.push({
          rule: 'secret_shape',
          category: 'secret',
          points: 60,
          reason: `${label} in args (${shortFingerprint(m[0])})`,
          evidence: label,
        })
      }
    }

    // Safe-list: only emit a negative factor when at least one positive
    // factor would otherwise raise the score — avoids noise on benign reads.
    if (factors.length > 0) {
      for (const safe of SAFE_LIST_PATHS) {
        if (safe.pattern.test(argsText)) {
          factors.push({
            rule: 'safe_list_docs',
            category: 'secret',
            points: -10,
            reason: safe.reason,
          })
          break
        }
      }
    }

    return factors
  },
}

// Test-only export — internal counts so the suite can assert the curated set
// hasn't been silently truncated.
export const _COUNTS = {
  pathPatterns: ALL_PATH_PATTERNS.length,
  contentPatterns: CONTENT_PATTERNS.length,
  safeList: SAFE_LIST_PATHS.length,
}
