import { shortFingerprint } from './secret-patterns.js'
import type { RiskFactor, RiskRule } from './types.js'

// =============================================================================
// PROMPT INJECTION HEURISTICS (#228 / C5)
// =============================================================================
//
// Cheap regex layer that catches the obvious injection attempts before they
// get to the agent. The hard cases — paraphrased / context-aware injections —
// belong to C8 (LLM verification). All English patterns have a Turkish
// counterpart in the categories where the spec calls for it; Foreman is
// built for a Turkish-speaking user and a Turkish-targeting phishing email
// must score the same as its English equivalent.
//
// Sources: OWASP LLM01, PromptBench, LakeraAI prompt-injection database.

// =============================================================================
// Category pattern shape
// =============================================================================

interface InjectionPattern {
  pattern: RegExp
  /** Short human reason — the modal renders this instead of the regex source. */
  reason: string
}

interface InjectionCategory {
  /** Stable factor id — written to factors[].rule */
  id: string
  /** Default per-match points. */
  points: number
  patterns: readonly InjectionPattern[]
}

// JS regex `\b` only knows ASCII word characters even with the `u` flag —
// `\bşifre` never matches because `ş` is non-word to `\b`. We use a manual
// boundary that asserts the previous char is NOT a letter (Latin or
// Turkish) or digit/underscore. Lookbehind needs ES2018+ (Node ≥10).
const W = "A-Za-z0-9_\\u00C7\\u00D6\\u00DC\\u011E\\u0130\\u0131\\u015E\\u00E7\\u00F6\\u00FC\\u011F\\u0131\\u0151\\u015F"
const LB = `(?<![${W}])`

// =============================================================================
// 1. System-prompt override (+50)
// =============================================================================

const SYSTEM_OVERRIDE: InjectionCategory = {
  id: 'injection_system_override',
  points: 50,
  patterns: [
    // English
    {
      pattern:
        /\bignore\s+(?:all\s+|the\s+)?(?:previous|prior|above|earlier|original)\s+(?:instructions?|prompts?|messages?|rules?)\b/iu,
      reason: '"ignore previous instructions"',
    },
    {
      pattern:
        /\bdisregard\s+(?:all\s+|the\s+|everything\s+)?(?:above|prior|previous|previously|original|earlier|everything)\b/iu,
      reason: '"disregard the above / disregard everything"',
    },
    {
      pattern: /\bforget\s+(?:everything|all|the|previous|prior|earlier)\b/iu,
      reason: '"forget everything"',
    },
    {
      pattern:
        /\boverride\s+(?:the\s+)?(?:system|previous|original|prior)\s+(?:prompt|instructions?|rules?)\b/iu,
      reason: '"override the system prompt"',
    },
    {
      pattern: /\byou\s+are\s+now\s+(?:a|an)\s+\w/iu,
      reason: '"you are now a/an …" (role replacement)',
    },
    {
      pattern: /\bnew\s+instructions?\s*:/iu,
      reason: '"new instructions:"',
    },
    {
      pattern: /\byour\s+real\s+instructions?\s+are\b/iu,
      reason: '"your real instructions are"',
    },
    {
      pattern:
        /\b(?:developer|debug|god|admin|root|dan)\s+mode\s+(?:on|enabled|activated|engaged)\b/iu,
      reason: '"developer/admin/DAN mode on"',
    },
    {
      pattern: /\bjailbreak\b/iu,
      reason: '"jailbreak" keyword',
    },
    // Turkish — `\b` is ASCII-only in JS regex, so use the Latin+Turkish
    // negative lookbehind `LB` instead. Noun roots are matched with optional
    // plural (-lar) and case (-ı / -i / -ları / -leri) suffixes so
    // talimat / talimatlar / talimatları all match.
    {
      pattern: new RegExp(
        LB +
          'önceki\\s+(?:tüm\\s+)?(?:talimat|yönerge|kural)(?:lar)?(?:ı|i|ları|leri)?\\s+(?:göz\\s+ardı\\s+et|yok\\s+say|unut|sil|görmezden\\s+gel)',
        'iu',
      ),
      reason: '[TR] "önceki talimatları yok say"',
    },
    {
      pattern: new RegExp(
        LB +
          'yukarıdaki\\s+(?:yönerge|talimat|kural)(?:lar)?(?:ı|i|ları|leri)?\\s+(?:yok\\s+say|göz\\s+ardı\\s+et|unut|sil|görmezden\\s+gel)',
        'iu',
      ),
      reason: '[TR] "yukarıdaki yönergeleri yok say"',
    },
    {
      pattern: new RegExp(LB + 'sen\\s+artık\\s+(?:bir\\s+)?\\S', 'iu'),
      reason: '[TR] "sen artık … asistansın/botsun" (role replacement)',
    },
    {
      pattern: new RegExp(LB + 'yeni\\s+talimat(?:lar)?\\s*:', 'iu'),
      reason: '[TR] "yeni talimat(lar):"',
    },
    {
      pattern: new RegExp(
        LB +
          '(?:sistem|kural)\\s+(?:prompt|komut|talimat)(?:u|ı|unu|ını)?\\s+(?:görmezden\\s+gel|yok\\s+say|atla|göz\\s+ardı\\s+et)',
        'iu',
      ),
      reason: '[TR] "sistem promptunu görmezden gel"',
    },
    {
      pattern: new RegExp(
        LB +
          '(?:geliştirici|yönetici|admin|root|tanrı|dan)\\s+modu(?:nda)?\\s*(?:çalış|aç|etkinleştir|geç)',
        'iu',
      ),
      reason: '[TR] "geliştirici modunda çalış"',
    },
  ],
}

// =============================================================================
// 2. Instruction smuggling — chat-template markers (+45)
// =============================================================================

const INSTRUCTION_SMUGGLING: InjectionCategory = {
  id: 'injection_smuggling',
  points: 45,
  patterns: [
    {
      pattern: /\[\/?INST\]/i,
      reason: 'Llama [INST] marker',
    },
    {
      pattern: /\[\/?(?:SYSTEM|SYS|ADMIN|USER)\]/i,
      reason: '[SYSTEM] / [SYS] / [ADMIN] marker',
    },
    {
      pattern: /<\|(?:system|im_start|im_end|assistant|user|endoftext)\|>/i,
      reason: 'ChatML / Qwen / OpenAI role tag',
    },
    {
      pattern: /###\s+(?:System|Assistant|Human|Instruction|Response)\s*:/u,
      reason: 'Alpaca / chat-template marker',
    },
    {
      pattern: /\[BEGIN\s+(?:ADMIN|SYSTEM|ROOT)\]/i,
      reason: '[BEGIN ADMIN/SYSTEM] block',
    },
    {
      // Handles both literal JSON ({"role":"system"}) and string-escaped JSON
      // ({\"role\":\"system\"}) that lands inside a stringified args body.
      // Also tolerates bare keys like `{ role: "system" }`.
      pattern: /\{\s*\\?["']?role\\?["']?\s*:\s*\\?["']system\\?["']/i,
      reason: 'Raw JSON {role:"system"} injection',
    },
    {
      pattern: /<system>|<\/system>/i,
      reason: '<system> XML-style tag',
    },
  ],
}

// =============================================================================
// 3. Data exfiltration prompts (+50)
// =============================================================================

const DATA_EXFIL: InjectionCategory = {
  id: 'injection_data_exfil',
  points: 50,
  patterns: [
    // English
    {
      pattern:
        /\b(?:send|share|post|upload|leak|paste|email|deliver|forward)\s+(?:the\s+)?(?:contents?\s+of\s+)?(?:\.env|api[_\s]?key|secret|password|credential|token)/iu,
      reason: '"send/share/upload the .env/api_key/secret"',
    },
    {
      pattern:
        /\b(?:send|share|paste|post)\s+(?:it|them|that|those)\s+to\s+(?:https?|webhook|@|mailto)/iu,
      reason: '"send it to webhook/mailto/url"',
    },
    {
      pattern:
        /\binclude\s+the\s+(?:full\s+)?(?:contents?|body|text)\s+of\s+(?:\.env|\/etc|~\/\.ssh|\/proc)/iu,
      reason: '"include the contents of .env / /etc / ~/.ssh / /proc"',
    },
    {
      pattern:
        /\bcopy\s+(?:the\s+)?(?:\.env|api[_\s]?key|secret|password|token)\s+(?:to|into|here|below|out)/iu,
      reason: '"copy the .env / api_key here"',
    },
    {
      pattern: /\becho\s+[^\n]{1,200}>\s*\/dev\/tcp\//u,
      reason: '"echo … > /dev/tcp" reverse-shell instruction',
    },
    {
      pattern: /\bexfiltrate\s+(?:the\s+)?(?:data|secret|file|env|key)/iu,
      reason: '"exfiltrate the …" (explicit)',
    },
    // Turkish — same `\b`-is-ASCII-only fix as system-override. `{0,3}?`
    // intervening tokens lets "parolayı bana yolla" match — Turkish often
    // puts an indirect-object pronoun between the noun and the verb.
    {
      pattern: new RegExp(
        LB +
          '(?:\\.env|şifre|parola|secret|token|credential)(?:yı|yi|ı|i|leri|ları)?\\s+(?:\\S+\\s+){0,3}?(?:gönder|paylaş|yolla|at|ilet|kopyala)',
        'iu',
      ),
      reason: '[TR] "şifreyi/.env\'i gönder/paylaş"',
    },
    {
      pattern: new RegExp(
        LB + 'api\\s+anahtar(?:ı|i|ını|leri)?\\s*(?:gönder|paylaş|yolla|at|ilet|göster|listele)',
        'iu',
      ),
      reason: '[TR] "api anahtarını gönder/göster"',
    },
    {
      pattern: new RegExp(LB + 'şu\\s+adrese\\s+(?:gönder|yolla|paylaş|at|ilet|post(?:la)?)', 'iu'),
      reason: '[TR] "şu adrese gönder"',
    },
    {
      pattern: new RegExp(
        LB +
          '(?:tüm\\s+)?(?:şifre|parola|secret|token|kullanıcı\\s+adı)(?:ler|lar)?(?:i|ı|leri|ları|sini|ini)?\\s+(?:göster|listele|yaz|söyle|getir|yolla)',
        'iu',
      ),
      reason: '[TR] "şifrelerini listele/göster"',
    },
    {
      pattern: new RegExp(
        LB +
          '(?:\\.env|config|gizli\\s+dosya|secret)(?:\\s+dosyas\\S{0,8})?\\s+(?:içeriğini|içerigini|içeri[gğ]i)\\s+(?:göster|paylaş|gönder|yaz)',
        'iu',
      ),
      reason: '[TR] "config içeriğini göster"',
    },
  ],
}

// =============================================================================
// 4. Authority impersonation (+40)
// =============================================================================

const AUTHORITY_IMPERSONATION: InjectionCategory = {
  id: 'injection_authority',
  points: 40,
  patterns: [
    // English
    {
      pattern:
        /\bi\s+am\s+(?:your\s+|the\s+)?(?:admin|administrator|owner|developer|maintainer|operator|root|sysadmin|creator)\b/iu,
      reason: '"I am the admin/developer/owner"',
    },
    {
      pattern:
        /\bthis\s+is\s+(?:your\s+|the\s+)?(?:developer|admin|operator|owner|root|sysadmin|maintainer)\b/iu,
      reason: '"this is the developer/admin"',
    },
    {
      // `^...$` with `m` flag matches line starts. But text is JSON-stringified
      // (no real newlines), so use a word-boundary form instead.
      pattern: /\bsudo\s*:\s*(?:do|run|exec|execute|allow|grant|please|run)/i,
      reason: '"sudo:" prefix in prompt',
    },
    {
      pattern: /\[\s*(?:as\s+root|admin\s+override|sudo|root\s+access|god\s+mode)\s*\]/iu,
      reason: '[as root] / [admin override] / [sudo] tag',
    },
    {
      pattern:
        /\bauthori[sz]ed\s+by\s+(?:foreman|anthropic|nous|openai|google|microsoft|the\s+team)/iu,
      reason: '"authorized by Anthropic/Foreman/OpenAI/…"',
    },
    {
      pattern:
        /\bon\s+behalf\s+of\s+(?:the\s+)?(?:team|user|admin|root|owner|developer)\b/iu,
      reason: '"on behalf of the admin/owner"',
    },
    {
      pattern: /\bemergency\s+(?:override|access|protocol|escalation)\b/iu,
      reason: '"emergency override/access"',
    },
    // Turkish — same `\b` ASCII fix
    {
      pattern: new RegExp(
        LB +
          'ben\\s+(?:senin\\s+)?(?:yöneticin|geliştiricin|sahibin|yapımcın|admin(?:in)?|sysadminin|operatörün|yaratıcın)(?:im|iyim|yim)?(?![${W}])'.replace(
            '${W}',
            W,
          ),
        'iu',
      ),
      reason: '[TR] "ben senin yöneticinim/geliştiricinim"',
    },
    {
      pattern: new RegExp(
        LB +
          '(?:foreman|anthropic|openai|nous|google|microsoft)\\s+(?:tarafından|adına|adina)\\s+(?:yetkilendir|onay|izin\\s+ver|gönderil)',
        'iu',
      ),
      reason: '[TR] "Anthropic tarafından yetkilendirilmiş"',
    },
    {
      pattern: new RegExp(LB + 'acil\\s+(?:durum|müdahale|geçiş|atlama|yetki|onay)', 'iu'),
      reason: '[TR] "acil durum / acil müdahale"',
    },
  ],
}

// =============================================================================
// 5. Encoding / obfuscation (+35) — gated by safe-list for hash/sig fields
// =============================================================================

// Long contiguous base64-y block (≥200 chars from the alphabet).
const BASE64_LONG_RE = /[A-Za-z0-9+/]{200,}={0,2}/

// Long contiguous hex block (≥200 chars).
const HEX_LONG_RE = /[0-9a-fA-F]{200,}/

// Suspicious unicode-escape chain. After JSON.stringify each source `\` is
// doubled, so the text contains `\\u00XX` rather than `\u00XX`.
const UNICODE_ESCAPE_RE = /(?:\\\\u00[0-9a-fA-F]{2}){10,}/

// Suspicious URL-encoded payload chain.
const URL_ENCODED_RE = /(?:%[0-9a-fA-F]{2}){20,}/

// Explicit encoding markers.
const ENCODING_MARKER_RE = /\b(?:ROT13|atbash)\s*:\s*\S/iu

// =============================================================================
// Safe-list — only for the encoding category
// =============================================================================
//
// Long base64 / hex blocks inside obviously-binary fields are signed payloads,
// hashes, or attachments — don't false-positive on those. The check looks
// backwards from the match position for a recognised field name within 80
// characters.

const HASH_FIELD_RE =
  /["']?(?:hash|sha\d*|md5|sig|signature|checksum|fingerprint|digest|hmac|base64|content_encoded|attachment)["']?\s*[:=]\s*["']?$/i

function isInsideHashField(text: string, matchIdx: number): boolean {
  if (matchIdx <= 0) return false
  const lookback = text.slice(Math.max(0, matchIdx - 80), matchIdx)
  return HASH_FIELD_RE.test(lookback)
}

// SHA-256 / SHA-512 are exactly 64 / 128 hex chars — treat as benign hashes if
// they appear standalone (not adjacent to an instruction phrase).
function isExactHashLength(s: string): boolean {
  return s.length === 64 || s.length === 96 || s.length === 128
}

// =============================================================================
// Categories — checked in order. One factor per category.
// =============================================================================

const CATEGORIES: readonly InjectionCategory[] = [
  SYSTEM_OVERRIDE,
  INSTRUCTION_SMUGGLING,
  DATA_EXFIL,
  AUTHORITY_IMPERSONATION,
]

// =============================================================================
// Rule
// =============================================================================

export const injectionPatternRule: RiskRule = {
  name: 'prompt_injection',
  category: 'injection',
  evaluate(req): RiskFactor[] {
    let text: string
    try {
      text = JSON.stringify(req.args ?? null)
    } catch {
      return []
    }
    if (text.length === 0) return []

    const factors: RiskFactor[] = []

    // 1–4: phrase-based categories. One factor per category (first match wins).
    for (const cat of CATEGORIES) {
      for (const p of cat.patterns) {
        const m = p.pattern.exec(text)
        if (m) {
          factors.push({
            rule: cat.id,
            category: 'injection',
            points: cat.points,
            reason: p.reason,
            evidence: shortFingerprint(m[0]),
          })
          break
        }
      }
    }

    // 5: encoding category — only fires when the encoded block is NOT inside a
    // recognised hash/signature field. Multiple encoding factors can fire if
    // distinct kinds appear (base64 + unicode escape + url encoded).
    const encodingFactors = detectEncoding(text)
    for (const f of encodingFactors) factors.push(f)

    return factors
  },
}

function detectEncoding(text: string): RiskFactor[] {
  const out: RiskFactor[] = []
  const seenSubrules = new Set<string>()

  function tryAdd(
    re: RegExp,
    subrule: 'base64' | 'hex' | 'unicode' | 'urlencoded' | 'marker',
    reason: string,
  ): void {
    const m = re.exec(text)
    if (!m) return
    if (seenSubrules.has(subrule)) return
    if (
      (subrule === 'base64' || subrule === 'hex') &&
      (isInsideHashField(text, m.index) || isExactHashLength(m[0]))
    ) {
      return
    }
    seenSubrules.add(subrule)
    out.push({
      rule: 'injection_encoded',
      category: 'injection',
      points: 35,
      reason,
      evidence: shortFingerprint(m[0]),
    })
  }

  tryAdd(BASE64_LONG_RE, 'base64', 'Long base64 block in args (possible payload)')
  tryAdd(HEX_LONG_RE, 'hex', 'Long hex block in args (possible payload)')
  tryAdd(
    UNICODE_ESCAPE_RE,
    'unicode',
    'Unicode-escape chain (\\u00XX… — obfuscated payload)',
  )
  tryAdd(URL_ENCODED_RE, 'urlencoded', 'URL-encoded payload chain (%XX…)')
  tryAdd(ENCODING_MARKER_RE, 'marker', 'Explicit encoding marker (ROT13:/atbash:)')

  return out
}

// Test-only export — counts so the suite can guard against silent truncation.
export const _INJECTION_COUNTS = {
  systemOverride: SYSTEM_OVERRIDE.patterns.length,
  smuggling: INSTRUCTION_SMUGGLING.patterns.length,
  dataExfil: DATA_EXFIL.patterns.length,
  authority: AUTHORITY_IMPERSONATION.patterns.length,
  encodingSubrules: 5,
  total:
    SYSTEM_OVERRIDE.patterns.length +
    INSTRUCTION_SMUGGLING.patterns.length +
    DATA_EXFIL.patterns.length +
    AUTHORITY_IMPERSONATION.patterns.length +
    5,
}
