import { describe, expect, it } from 'vitest'
import {
  predicateHintForFactor,
  predicateHintsForFactors,
} from '../../../src/core/risk-rules/predicate-hint.js'
import type { RiskFactor } from '../../../src/core/risk-rules/types.js'

function factor(overrides: Partial<RiskFactor>): RiskFactor {
  return {
    rule: 'secret_path',
    category: 'secret',
    points: 60,
    reason: '.env',
    ...overrides,
  }
}

// =============================================================================
// #526 — predicate-hint mapper. Pure function tests; no DB / fs.
// Each branch verifies the actionId naming convention (`block_<factor>`)
// matches what the approval submit-handler uses to look the proposal up
// again from the persisted approval row.
// =============================================================================

describe('predicateHintForFactor — secret-shaped factors', () => {
  it('maps secret_path on a .env path to a \\.env(\\..*)?$ pathMatch', () => {
    const hint = predicateHintForFactor(
      factor({ rule: 'secret_path' }),
      { path: '.env' },
      'hermes',
    )
    expect(hint).toMatchObject({
      actionId: 'block_secret_path',
      reason: 'secret_path',
      predicate: { pathMatch: ['\\.env(\\..*)?$'] },
    })
    expect(hint!.label).toContain('.env*')
    expect(hint!.label).toContain('hermes')
  })

  it('captures .env.local + .env.production with the same family pattern', () => {
    for (const path of ['.env.local', '.env.production', '.envrc']) {
      const hint = predicateHintForFactor(
        factor({ rule: 'secret_path' }),
        { path },
        'hermes',
      )
      expect(hint!.predicate.pathMatch).toEqual(['\\.env(\\..*)?$'])
    }
  })

  it('maps an SSH-key path to the id_<algo>(\\.pub)?$ family pattern', () => {
    const hint = predicateHintForFactor(
      factor({ rule: 'secret_path' }),
      { path: '/Users/fatih/.ssh/id_rsa' },
      'hermes',
    )
    expect(hint!.predicate.pathMatch).toEqual([
      '/id_(rsa|ed25519|ecdsa|dsa)(\\.pub)?$',
    ])
    expect(hint!.label).toContain('SSH')
  })

  it('maps a .pem path to the private-key family pattern', () => {
    const hint = predicateHintForFactor(
      factor({ rule: 'secret_path' }),
      { path: '/etc/ssl/private/server.pem' },
      'hermes',
    )
    expect(hint!.predicate.pathMatch).toEqual(['\\.(pem|key|crt|p12|pfx)$'])
    expect(hint!.label).toContain('private-key')
  })

  it('falls back to basename anchor for unrecognised secret-shaped paths', () => {
    // Dash is not a regex metacharacter outside character classes, so the
    // helper leaves it un-escaped. The anchored pattern is enough to
    // ensure the rule only matches the same basename.
    const hint = predicateHintForFactor(
      factor({ rule: 'secret_path' }),
      { path: '/opt/secrets/api-token' },
      'hermes',
    )
    expect(hint!.predicate.pathMatch).toEqual(['/api-token$'])
  })

  it('returns null when args has no path field', () => {
    expect(
      predicateHintForFactor(
        factor({ rule: 'secret_path' }),
        { url: 'https://example.com' },
        'hermes',
      ),
    ).toBeNull()
  })
})

describe('predicateHintForFactor — shell-destructive factors', () => {
  it('maps shell_rm_rf_general to argContains "rm -rf"', () => {
    const hint = predicateHintForFactor(
      factor({
        rule: 'shell_rm_rf_general',
        category: 'shell',
        points: 60,
        reason: 'rm -rf detected',
      }),
      { command: 'rm', args: ['-rf', '/tmp/foo'] },
      'hermes',
    )
    expect(hint).toMatchObject({
      actionId: 'block_shell_rm_rf_general',
      predicate: { argContains: 'rm -rf' },
    })
    expect(hint!.label).toContain('rm -rf')
  })

  it('maps shell_sudo to argContains "sudo"', () => {
    const hint = predicateHintForFactor(
      factor({
        rule: 'shell_sudo',
        category: 'shell',
        points: 40,
        reason: 'sudo invocation',
      }),
      { command: 'sudo apt install' },
      'hermes',
    )
    expect(hint!.predicate.argContains).toBe('sudo')
  })

  it('returns null when shell args have no command field', () => {
    expect(
      predicateHintForFactor(
        factor({ rule: 'shell_rm_rf_general', category: 'shell' }),
        { something: 'else' },
        'hermes',
      ),
    ).toBeNull()
  })
})

describe('predicateHintForFactor — network factors', () => {
  it('maps a network_paste_share factor with evidence host to argContains', () => {
    const hint = predicateHintForFactor(
      factor({
        rule: 'network_paste_share',
        category: 'network',
        points: 35,
        reason: 'pastebin upload',
        evidence: 'pastebin.com',
      }),
      { url: 'https://pastebin.com/raw/abc123' },
      'hermes',
    )
    expect(hint).toMatchObject({
      actionId: 'block_network_paste_share',
      predicate: { argContains: 'pastebin.com' },
    })
    expect(hint!.label).toContain('pastebin.com')
  })

  it('explicitly skips network_safe_host — never offer "block google.com"', () => {
    expect(
      predicateHintForFactor(
        factor({
          rule: 'network_safe_host',
          category: 'network',
          points: -10,
          reason: 'safe host',
          evidence: 'github.com',
        }),
        { url: 'https://github.com/api' },
        'hermes',
      ),
    ).toBeNull()
  })

  it('returns null for network factor without evidence (host unknown)', () => {
    expect(
      predicateHintForFactor(
        factor({
          rule: 'network_ip_literal',
          category: 'network',
          points: 30,
          reason: 'ip literal',
          // no evidence
        }),
        { url: 'https://192.168.1.1' },
        'hermes',
      ),
    ).toBeNull()
  })
})

describe('predicateHintForFactor — structural factors return null', () => {
  it.each([
    ['first_agent_to_agent', 'structural'],
    ['loop_pingpong', 'loop'],
    ['loop_token_budget', 'loop'],
    ['responsibility_violation', 'structural'],
    ['injection_encoded', 'injection'],
  ] as const)('returns null for %s (no request-shaped predicate)', (rule, category) => {
    expect(
      predicateHintForFactor(
        factor({
          rule,
          category: category as RiskFactor['category'],
          points: 20,
          reason: 'whatever',
        }),
        { path: '.env' },
        'hermes',
      ),
    ).toBeNull()
  })
})

describe('predicateHintsForFactors', () => {
  it('returns proposals in factor order', () => {
    const out = predicateHintsForFactors(
      [
        factor({ rule: 'secret_path' }),
        factor({
          rule: 'network_paste_share',
          category: 'network',
          points: 35,
          reason: 'paste',
          evidence: 'pastebin.com',
        }),
      ],
      { path: '.env', url: 'https://pastebin.com' },
      'hermes',
    )
    expect(out.map((p) => p.actionId)).toEqual([
      'block_secret_path',
      'block_network_paste_share',
    ])
  })

  it('dedupes by actionId (two factors with the same rule)', () => {
    const out = predicateHintsForFactors(
      [
        factor({ rule: 'secret_path', reason: 'a' }),
        factor({ rule: 'secret_path', reason: 'b' }),
      ],
      { path: '.env' },
      'hermes',
    )
    expect(out).toHaveLength(1)
  })

  it('filters out factors that map to null', () => {
    const out = predicateHintsForFactors(
      [
        factor({ rule: 'secret_path' }),
        factor({
          rule: 'first_agent_to_agent',
          category: 'structural',
          points: 20,
          reason: 'structural',
        }),
      ],
      { path: '.env' },
      'hermes',
    )
    expect(out.map((p) => p.actionId)).toEqual(['block_secret_path'])
  })
})
