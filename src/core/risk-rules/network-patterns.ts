import type { RiskFactor, RiskRule } from './types.js'

// =============================================================================
// NETWORK / OUTBOUND URL PATTERNS (#227 / C4)
// =============================================================================
//
// Replaces the original `outbound_network` rule that flagged every URL with a
// flat +30. Now the URL host is classified into one of 8 categories — each
// category produces a `RiskFactor` whose points reflect the *kind* of risk
// (exfil destination is much worse than a CDN). IP literals, punycode, and
// suspicious TLDs are checked on top of (not instead of) the category match.
//
// Sources: CISA IOCs, URLhaus, Mozilla Public Suffix List, Phishing.Database.

// =============================================================================
// URL extraction
// =============================================================================

// Allow http:// and https://. Captures either a bracketed IPv6 host or a
// plain hostname (terminated by /, ", ', <, >, whitespace, or end of string).
const URL_RE = /https?:\/\/(\[[^\]\s]+\]|[^\s/"'<>]+)/gi

// Strip port + lowercase for matching. Returns the host body for IPv6 too.
function normaliseHost(rawHost: string): { host: string; ipv6: boolean } {
  if (rawHost.startsWith('[')) {
    const end = rawHost.indexOf(']')
    return { host: rawHost.slice(1, end).toLowerCase(), ipv6: true }
  }
  const colon = rawHost.indexOf(':')
  const host = colon >= 0 ? rawHost.slice(0, colon) : rawHost
  return { host: host.toLowerCase(), ipv6: false }
}

function tldOf(host: string): string {
  const dot = host.lastIndexOf('.')
  return dot >= 0 ? host.slice(dot + 1) : ''
}

function isIpv4(host: string): boolean {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return false
  return host.split('.').every((p) => {
    const n = Number(p)
    return n >= 0 && n <= 255
  })
}

// RFC1918 / link-local / loopback — lateral movement smell.
function isPrivateIpv4(host: string): boolean {
  if (!isIpv4(host)) return false
  const parts = host.split('.').map(Number)
  const a = parts[0]!
  const b = parts[1]!
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true
  return false
}

function isPunycodeHost(host: string): boolean {
  return host.split('.').some((label) => label.startsWith('xn--'))
}

// Single-script homoglyph check — Cyrillic а, е, о, р, с, у, х inside a domain
// that otherwise looks Latin.
function hasMixedScriptHomoglyph(host: string): boolean {
  const hasLatin = /[a-z]/.test(host)
  const hasCyrillic = /[Ѐ-ӿ]/.test(host)
  return hasLatin && hasCyrillic
}

// =============================================================================
// Category match helpers
// =============================================================================

function hostMatchesAny(host: string, targets: readonly string[]): string | null {
  for (const t of targets) {
    if (host === t || host.endsWith(`.${t}`)) return t
  }
  return null
}

// =============================================================================
// Categories
// =============================================================================

// 1. Known exfil destinations (paste-or-receive any data) — +60
const EXFIL_HOSTS = [
  'webhook.site',
  'requestbin.com',
  'requestbin.net',
  'beeceptor.com',
  'hookbin.com',
  'mockbin.org',
  'pipedream.com',
  'pipedream.net',
  'ngrok.io',
  'ngrok-free.app',
  'ngrok.app',
  'serveo.net',
  'localhost.run',
  'tunnel.run',
] as const

// 2. Paste / file-share sites — +45
const PASTE_HOSTS = [
  'pastebin.com',
  'pastebin.pl',
  'ghostbin.com',
  'ghostbin.co',
  'hastebin.com',
  'ix.io',
  '0bin.net',
  'controlc.com',
  'transfer.sh',
  'file.io',
  'tmpfiles.org',
  'catbox.moe',
  'litterbox.catbox.moe',
  'paste.ee',
  'dpaste.org',
] as const

// 3. URL shorteners — +35
const SHORTENER_HOSTS = [
  'bit.ly',
  't.co',
  'tinyurl.com',
  'ow.ly',
  'is.gd',
  'shorturl.at',
  'goo.gl',
  'cutt.ly',
  'rb.gy',
  's.id',
  'lnkd.in',
  'tiny.cc',
  'shrtco.de',
] as const

// 6. Suspicious TLDs — +25 (free / abused TLDs)
const SUSPICIOUS_TLDS = new Set([
  'tk',
  'ml',
  'ga',
  'cf',
  'gq',
  'xyz',
  'top',
  'icu',
  'cyou',
  'zip',
  'mov',
])

// 7. Mining pools — +50
const MINING_HOSTS = [
  'minexmr.com',
  'supportxmr.com',
  'nicehash.com',
  'f2pool.com',
  'pool.minexmr.com',
  'xmrpool.eu',
  'monerohash.com',
  'nanopool.org',
  '2miners.com',
  'ethermine.org',
] as const

// 8. Dark web — +40 (.onion / .i2p)
function isDarkWeb(host: string): boolean {
  return host.endsWith('.onion') || host.endsWith('.i2p')
}

// =============================================================================
// Safe-list (known-good API hosts, -15 each — only when a positive fires)
// =============================================================================

const SAFE_HOSTS = [
  // GitHub
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
  'gist.github.com',
  'githubusercontent.com',
  // Anthropic
  'anthropic.com',
  'api.anthropic.com',
  'claude.ai',
  'console.anthropic.com',
  // OpenAI
  'openai.com',
  'api.openai.com',
  'platform.openai.com',
  // Google AI / Gemini
  'generativelanguage.googleapis.com',
  // Package managers
  'registry.npmjs.org',
  'npmjs.org',
  'npmjs.com',
  'yarnpkg.com',
  'crates.io',
  'pypi.org',
  'files.pythonhosted.org',
  'rubygems.org',
  // Chat platforms (legit webhook flows)
  'discord.com',
  'discordapp.com',
  'api.telegram.org',
  'hooks.slack.com',
  'slack.com',
  // Container + CDN
  'docker.io',
  'docker.com',
  'registry.hub.docker.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cloudflare.com',
  // Cloud providers (broad — common API endpoints)
  'googleapis.com',
  'amazonaws.com',
  'azure.com',
] as const

function safeHostFor(host: string): string | null {
  return hostMatchesAny(host, SAFE_HOSTS)
}

// =============================================================================
// Rule
// =============================================================================

export const networkPatternRule: RiskRule = {
  name: 'network_outbound',
  category: 'network',
  evaluate(req): RiskFactor[] {
    let text: string
    try {
      text = JSON.stringify(req.args ?? null)
    } catch {
      return []
    }
    // Tool name often carries the URL too (e.g. fetch("https://...") wraps it).
    const haystack = `${text} ${req.targetTool ?? ''}`
    if (!haystack.includes('http')) return []

    const factors: RiskFactor[] = []
    const seenHosts = new Set<string>()

    for (const m of haystack.matchAll(URL_RE)) {
      const { host, ipv6 } = normaliseHost(m[1] ?? '')
      if (!host) continue
      if (seenHosts.has(host)) continue
      seenHosts.add(host)

      const tld = tldOf(host)
      const factorsBefore = factors.length

      // --- IP literal --------------------------------------------------------
      if (ipv6 || isIpv4(host)) {
        const isPrivate = isPrivateIpv4(host)
        factors.push({
          rule: 'network_ip_literal',
          category: 'network',
          points: isPrivate ? 60 : 50,
          reason: isPrivate
            ? 'IP-based URL — private/RFC1918 (lateral movement signal)'
            : 'IP-based URL (no DNS hostname)',
          evidence: host,
        })
        // Don't return early — punycode/homoglyph can't co-occur with an IP,
        // but TLD/category lookups skipped for IPs are intentional.
        continue
      }

      // --- Punycode / homoglyph ---------------------------------------------
      if (isPunycodeHost(host)) {
        factors.push({
          rule: 'network_punycode',
          category: 'network',
          points: 50,
          reason: 'Punycode hostname (possible homoglyph / phishing)',
          evidence: host,
        })
      }
      if (hasMixedScriptHomoglyph(host)) {
        factors.push({
          rule: 'network_mixed_script',
          category: 'network',
          points: 50,
          reason: 'Hostname mixes Latin + Cyrillic letters (homoglyph attack)',
          evidence: host,
        })
      }

      // --- Category match (first match wins) --------------------------------
      const exfil = hostMatchesAny(host, EXFIL_HOSTS)
      if (exfil) {
        factors.push({
          rule: 'network_exfil_destination',
          category: 'network',
          points: 60,
          reason: `Known exfil endpoint (${exfil})`,
          evidence: host,
        })
      } else {
        const paste = hostMatchesAny(host, PASTE_HOSTS)
        if (paste) {
          factors.push({
            rule: 'network_paste_share',
            category: 'network',
            points: 45,
            reason: `Paste / file-share site (${paste})`,
            evidence: host,
          })
        } else {
          const shortener = hostMatchesAny(host, SHORTENER_HOSTS)
          if (shortener) {
            factors.push({
              rule: 'network_url_shortener',
              category: 'network',
              points: 35,
              reason: `URL shortener (${shortener}) hides the real destination`,
              evidence: host,
            })
          } else {
            const mining = hostMatchesAny(host, MINING_HOSTS)
            if (mining) {
              factors.push({
                rule: 'network_mining_pool',
                category: 'network',
                points: 50,
                reason: `Cryptocurrency mining pool (${mining})`,
                evidence: host,
              })
            } else if (isDarkWeb(host)) {
              factors.push({
                rule: 'network_dark_web',
                category: 'network',
                points: 40,
                reason: 'Dark-web hostname (.onion / .i2p)',
                evidence: host,
              })
            } else if (SUSPICIOUS_TLDS.has(tld)) {
              factors.push({
                rule: 'network_suspicious_tld',
                category: 'network',
                points: 25,
                reason: `Suspicious / free TLD (.${tld})`,
                evidence: host,
              })
            }
          }
        }
      }

      // No category fired and no IP/punycode — fall through.
      void factorsBefore
    }

    // Safe-list — only emit if at least one positive factor fired.
    if (factors.length > 0) {
      const safeSeen = new Set<string>()
      for (const m of haystack.matchAll(URL_RE)) {
        const { host } = normaliseHost(m[1] ?? '')
        if (!host || safeSeen.has(host)) continue
        const safe = safeHostFor(host)
        if (safe) {
          safeSeen.add(host)
          factors.push({
            rule: 'network_safe_host',
            category: 'network',
            points: -15,
            reason: `${safe} is a known-good API / CDN host`,
            evidence: host,
          })
        }
      }
    }

    return factors
  },
}

// Test-only export — counts so the suite can guard against silent truncation.
export const _NETWORK_COUNTS = {
  exfil: EXFIL_HOSTS.length,
  paste: PASTE_HOSTS.length,
  shorteners: SHORTENER_HOSTS.length,
  mining: MINING_HOSTS.length,
  suspiciousTlds: SUSPICIOUS_TLDS.size,
  safeHosts: SAFE_HOSTS.length,
  totalHosts:
    EXFIL_HOSTS.length +
    PASTE_HOSTS.length +
    SHORTENER_HOSTS.length +
    MINING_HOSTS.length,
}
