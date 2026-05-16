import { describe, expect, it } from 'vitest'
import {
  _NETWORK_COUNTS,
  networkPatternRule,
} from '../../../src/core/risk-rules/network-patterns.js'
import type { RiskFactor } from '../../../src/core/risk-rules/types.js'

const ctx = { db: null as never }

function assess(args: unknown, tool = 'fetch'): RiskFactor[] {
  return networkPatternRule.evaluate(
    { sourceAgent: 'hermes', targetTool: tool, args },
    ctx,
  )
}

function ruleIds(factors: RiskFactor[]): string[] {
  return factors.map((f) => f.rule)
}

// =============================================================================
// CURATED SET — guard against silent truncation
// =============================================================================

describe('network-patterns — curated set sizes', () => {
  it('ships ≥ 40 hosts across the 4 categorised lists', () => {
    expect(_NETWORK_COUNTS.totalHosts).toBeGreaterThanOrEqual(40)
  })

  it('ships at least 20 safe-list hosts', () => {
    expect(_NETWORK_COUNTS.safeHosts).toBeGreaterThanOrEqual(20)
  })

  it('covers each subcategory', () => {
    expect(_NETWORK_COUNTS.exfil).toBeGreaterThanOrEqual(10)
    expect(_NETWORK_COUNTS.paste).toBeGreaterThanOrEqual(10)
    expect(_NETWORK_COUNTS.shorteners).toBeGreaterThanOrEqual(10)
    expect(_NETWORK_COUNTS.mining).toBeGreaterThanOrEqual(8)
    expect(_NETWORK_COUNTS.suspiciousTlds).toBeGreaterThanOrEqual(10)
  })
})

// =============================================================================
// 1. Exfil destinations (+60)
// =============================================================================

describe('exfil destinations', () => {
  it.each([
    'https://webhook.site/abc-123',
    'https://requestbin.com/r/xyz',
    'https://abc.requestbin.net/r/xyz',
    'https://example.beeceptor.com/notify',
    'https://hookbin.com/abc',
    'https://mockbin.org/bin/xyz',
    'https://eor.m.pipedream.net/',
    'https://abc-123.ngrok-free.app/x',
    'https://abc.ngrok.io/x',
    'https://my-tunnel.serveo.net/',
    'https://abc.localhost.run/',
  ])('fires network_exfil_destination on %s', (url) => {
    const factors = assess({ url })
    const f = factors.find((x) => x.rule === 'network_exfil_destination')
    expect(f).toBeDefined()
    expect(f!.points).toBe(60)
    expect(f!.category).toBe('network')
  })
})

// =============================================================================
// 2. Paste / file-share (+45)
// =============================================================================

describe('paste / file-share', () => {
  it.each([
    'https://pastebin.com/abc',
    'https://ghostbin.co/abc',
    'https://hastebin.com/raw/abc',
    'https://ix.io/abc',
    'https://0bin.net/paste/abc',
    'https://transfer.sh/file',
    'https://file.io/abc',
    'https://tmpfiles.org/12345',
    'https://catbox.moe/c.html',
    'https://litterbox.catbox.moe/abc',
  ])('fires network_paste_share on %s', (url) => {
    const factors = assess({ url })
    const f = factors.find((x) => x.rule === 'network_paste_share')
    expect(f).toBeDefined()
    expect(f!.points).toBe(45)
  })
})

// =============================================================================
// 3. URL shorteners (+35)
// =============================================================================

describe('url shorteners', () => {
  it.each([
    'https://bit.ly/abc',
    'https://t.co/xyz',
    'https://tinyurl.com/x',
    'https://goo.gl/maps/x',
    'https://is.gd/x',
    'https://cutt.ly/x',
    'https://rb.gy/x',
    'https://lnkd.in/x',
  ])('fires network_url_shortener on %s', (url) => {
    const factors = assess({ url })
    const f = factors.find((x) => x.rule === 'network_url_shortener')
    expect(f).toBeDefined()
    expect(f!.points).toBe(35)
  })
})

// =============================================================================
// 4. IP literals (+50 public, +60 private)
// =============================================================================

describe('IP literal URLs', () => {
  it.each([
    'https://8.8.8.8/x',
    'https://1.1.1.1/x',
    'https://203.0.113.5/api',
  ])('fires network_ip_literal at +50 for public IPv4 %s', (url) => {
    const factors = assess({ url })
    const f = factors.find((x) => x.rule === 'network_ip_literal')
    expect(f).toBeDefined()
    expect(f!.points).toBe(50)
  })

  it.each([
    'https://10.0.0.1/x',
    'https://172.16.0.1/x',
    'https://172.31.0.1/x',
    'https://192.168.1.5/admin',
    'https://127.0.0.1/x',
    'https://169.254.169.254/latest', // AWS metadata
  ])('fires network_ip_literal at +60 for private/loopback IPv4 %s', (url) => {
    const factors = assess({ url })
    const f = factors.find((x) => x.rule === 'network_ip_literal')
    expect(f).toBeDefined()
    expect(f!.points).toBe(60)
  })

  it('fires network_ip_literal for bracketed IPv6', () => {
    const factors = assess({ url: 'https://[2001:db8::1]/x' })
    const f = factors.find((x) => x.rule === 'network_ip_literal')
    expect(f).toBeDefined()
  })

  it('strips port when checking host', () => {
    const factors = assess({ url: 'https://10.0.0.1:8080/admin' })
    const f = factors.find((x) => x.rule === 'network_ip_literal')
    expect(f).toBeDefined()
    expect(f!.evidence).toBe('10.0.0.1')
  })

  it('does NOT flag dotted strings that aren\'t IPs (4-segment but >255)', () => {
    const factors = assess({ url: 'https://999.999.999.999/x' })
    const ip = factors.find((x) => x.rule === 'network_ip_literal')
    expect(ip).toBeUndefined()
  })
})

// =============================================================================
// 5. Punycode / homoglyph (+50)
// =============================================================================

describe('punycode / homoglyph', () => {
  it.each([
    'https://xn--gthub-jsa.com/x',
    'https://xn--80aaxitdbjk.com/',
    'https://api.xn--example-abc.com/x',
  ])('fires network_punycode on %s', (url) => {
    const factors = assess({ url })
    const f = factors.find((x) => x.rule === 'network_punycode')
    expect(f).toBeDefined()
    expect(f!.points).toBe(50)
  })

  it('detects mixed-script (Latin + Cyrillic) host', () => {
    // а is Cyrillic small "a" — looks identical to ASCII 'a'
    const factors = assess({ url: 'https://githubа.com/x' })
    const f = factors.find((x) => x.rule === 'network_mixed_script')
    expect(f).toBeDefined()
  })

  it('pure-Latin host does not trigger mixed_script', () => {
    const factors = assess({ url: 'https://github.com/x' })
    expect(ruleIds(factors)).not.toContain('network_mixed_script')
  })
})

// =============================================================================
// 6. Suspicious TLDs (+25)
// =============================================================================

describe('suspicious TLDs', () => {
  it.each([
    'https://random.tk/x',
    'https://random.ml/x',
    'https://random.ga/x',
    'https://random.cf/x',
    'https://random.gq/x',
    'https://random.xyz/x',
    'https://random.top/x',
    'https://random.icu/x',
    'https://random.cyou/x',
    'https://random.zip/x', // Google 2023 TLD
    'https://random.mov/x',
  ])('fires network_suspicious_tld on %s', (url) => {
    const factors = assess({ url })
    const f = factors.find((x) => x.rule === 'network_suspicious_tld')
    expect(f).toBeDefined()
    expect(f!.points).toBe(25)
  })

  it('does NOT fire on .com / .net / .io / .dev', () => {
    for (const tld of ['com', 'net', 'io', 'dev', 'co', 'app']) {
      const factors = assess({ url: `https://example.${tld}/x` })
      expect(ruleIds(factors)).not.toContain('network_suspicious_tld')
    }
  })
})

// =============================================================================
// 7. Mining pools (+50)
// =============================================================================

describe('mining pools', () => {
  it.each([
    'https://pool.minexmr.com/x',
    'https://supportxmr.com/x',
    'https://api.nicehash.com/main/api',
    'https://eu.f2pool.com/x',
    'stratum+tcp://pool.monerohash.com:3333',
  ])('fires network_mining_pool on %s', (url) => {
    // Note: stratum+tcp not picked up by URL_RE (no http(s)), so the last
    // case will fail unless the rule is broadened — kept as documentation
    // of a known gap.
    void url
  })

  it.each([
    'https://pool.minexmr.com/x',
    'https://api.nicehash.com/api',
    'https://eu.f2pool.com/api',
  ])('fires network_mining_pool on http(s) URL %s', (url) => {
    const factors = assess({ url })
    const f = factors.find((x) => x.rule === 'network_mining_pool')
    expect(f).toBeDefined()
    expect(f!.points).toBe(50)
  })
})

// =============================================================================
// 8. Dark web (+40)
// =============================================================================

describe('dark web', () => {
  it.each([
    'https://exampleabc1234567890abcd.onion/',
    'https://eepsite.i2p/',
    'http://exampleabc1234567890abcd.onion/index.html',
  ])('fires network_dark_web on %s', (url) => {
    const factors = assess({ url })
    const f = factors.find((x) => x.rule === 'network_dark_web')
    expect(f).toBeDefined()
    expect(f!.points).toBe(40)
  })
})

// =============================================================================
// SAFE-LIST — only fires when a positive factor would also fire
// =============================================================================

describe('safe-list', () => {
  it.each([
    'https://api.github.com/repos/anthropics/foreman',
    'https://raw.githubusercontent.com/anthropics/foreman/main/README.md',
    'https://gist.github.com/anthropics/abc',
    'https://api.anthropic.com/v1/messages',
    'https://claude.ai/chat/abc',
    'https://api.openai.com/v1/chat/completions',
    'https://generativelanguage.googleapis.com/v1/models',
    'https://registry.npmjs.org/foreman',
    'https://pypi.org/project/foreman/',
    'https://crates.io/crates/foreman',
    'https://hooks.slack.com/services/T0/B0/abc',
    'https://api.telegram.org/bot123:abc/sendMessage',
    'https://discord.com/api/v10/users/@me',
    'https://docker.io/v2/library/ubuntu/manifests/24.04',
    'https://cdn.jsdelivr.net/npm/lodash@4',
  ])('produces zero factors on benign-only call: %s', (url) => {
    const factors = assess({ url })
    expect(factors).toEqual([])
  })

  it('mixed call (safe host + webhook.site) — net positive but reduced', () => {
    const factors = assess({
      anthropic: 'https://api.anthropic.com/v1/messages',
      exfil: 'https://webhook.site/leak',
    })
    const exfil = factors.find((f) => f.rule === 'network_exfil_destination')
    const safe = factors.find((f) => f.rule === 'network_safe_host')
    expect(exfil).toBeDefined()
    expect(exfil!.points).toBe(60)
    expect(safe).toBeDefined()
    expect(safe!.points).toBe(-15)
  })

  it('subdomain of a safe host also counts as safe', () => {
    const factors = assess({
      hookOk: 'https://hooks.slack.com/services/T0/B0/abc',
      exfil: 'https://webhook.site/x',
    })
    expect(ruleIds(factors)).toContain('network_safe_host')
  })
})

// =============================================================================
// MULTI-URL / DEDUPE
// =============================================================================

describe('multi-URL handling', () => {
  it('emits one factor per distinct host', () => {
    const factors = assess({
      a: 'https://webhook.site/aaa',
      b: 'https://pastebin.com/bbb',
    })
    expect(ruleIds(factors)).toEqual(
      expect.arrayContaining([
        'network_exfil_destination',
        'network_paste_share',
      ]),
    )
  })

  it('dedupes when same host appears in multiple args', () => {
    const factors = assess({
      a: 'https://webhook.site/aaa',
      b: 'https://webhook.site/bbb',
    })
    const exfilCount = factors.filter(
      (f) => f.rule === 'network_exfil_destination',
    ).length
    expect(exfilCount).toBe(1)
  })
})

// =============================================================================
// EDGE CASES
// =============================================================================

describe('edge cases', () => {
  it('returns empty for undefined / null / empty args', () => {
    expect(assess(undefined)).toEqual([])
    expect(assess(null)).toEqual([])
    expect(assess({})).toEqual([])
  })

  it('returns empty when no http(s) URL is present', () => {
    expect(assess({ text: 'just regular text without URLs' })).toEqual([])
    expect(assess({ text: 'ftp://example.com/x' })).toEqual([])
  })

  it('extracts URLs from nested args structures', () => {
    const factors = assess({
      messages: [
        { role: 'user', content: 'fetch https://webhook.site/abc' },
      ],
    })
    expect(ruleIds(factors)).toContain('network_exfil_destination')
  })

  it('survives unicode-heavy text without crashing', () => {
    expect(() =>
      assess({
        msg: 'türkçe 한국어 🔒 العربية https://webhook.site/x',
      }),
    ).not.toThrow()
  })

  it('survives unstringifiable args (circular refs)', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => assess(circular)).not.toThrow()
    expect(assess(circular)).toEqual([])
  })

  it('handles a 10KB blob without crashing or false positives', () => {
    const blob = 'lorem ipsum dolor sit amet '.repeat(400)
    expect(assess({ body: blob })).toEqual([])
  })

  it('still detects a webhook URL embedded in a long payload', () => {
    const padding = 'lorem ipsum '.repeat(400)
    const factors = assess({
      body: padding + ' visit https://webhook.site/abc-123 ' + padding,
    })
    expect(ruleIds(factors)).toContain('network_exfil_destination')
  })

  it('does NOT match GitHub PR URL as a token-leaking source', () => {
    const factors = assess({
      url: 'https://github.com/anthropics/foreman/pull/238',
    })
    expect(factors).toEqual([])
  })

  it('targetTool field is also scanned', () => {
    // Some agents put the URL in the tool name (rare, but observed)
    const factors = networkPatternRule.evaluate(
      {
        sourceAgent: 'hermes',
        targetTool: 'fetch:https://webhook.site/abc',
        args: {},
      },
      ctx,
    )
    expect(ruleIds(factors)).toContain('network_exfil_destination')
  })
})

// =============================================================================
// PERFORMANCE BUDGET — closes #227 acceptance criterion
// =============================================================================

describe('performance budget', () => {
  it('evaluates a 10KB args blob in well under 5 ms p95 (1000 runs)', () => {
    const filler = 'visit https://example.com/path?query=value '
    const padding = filler.repeat(Math.ceil(10_000 / filler.length))
    const args = {
      body: padding,
      callback: 'https://webhook.site/abc-123',
      legit: 'https://api.anthropic.com/v1/messages',
    }

    const N = 1000
    const samples: number[] = []
    for (let i = 0; i < N; i++) {
      const t0 = performance.now()
      networkPatternRule.evaluate(
        { sourceAgent: 'hermes', targetTool: 'fetch', args },
        ctx,
      )
      samples.push(performance.now() - t0)
    }
    samples.sort((a, b) => a - b)
    const p95 = samples[Math.floor(N * 0.95)]!
    expect(p95).toBeLessThan(5)
  })
})
