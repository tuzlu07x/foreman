import type { RiskFactor } from './types.js'

// =============================================================================
// Risk factor → policy predicate hint (#526)
// =============================================================================
//
// When the approval modal fires for a request that hit a recognisable
// risk factor (secret_path, shell_destructive, network_paste_share, …),
// Foreman offers the user a one-tap "block this pattern permanently"
// button alongside the standard Allow / Deny actions. The button needs
// (a) a short label users can scan ("Block `.env*` reads from hermes")
// and (b) a predicate that policy-engine can store + match against
// future requests.
//
// This module is the pure mapper from `(factor, args) → PredicateHint`.
// Each branch knows its factor name + how to read the matched evidence
// out of the request args so the suggested predicate is tight (not
// "block all reads from hermes" but "block .env* reads from hermes").
//
// Factors without a clean predicate mapping return null — the modal
// falls back to plain Allow / Deny.

/** Concrete predicate the user accepts when tapping the modal button.
 *  Mirrors `RuleConditions`'s predicate fields exactly so the policy
 *  engine can store them with no translation. */
export interface PredicateHint {
  /** Path regex array (OR'd inside the rule). Set for path-shaped factors. */
  pathMatch?: string[]
  /** Target tool name regex. Set when the factor narrows by tool. */
  toolPattern?: string
  /** Case-insensitive substring across args. Set for content-shaped
   *  factors (e.g. exfil destination domain). */
  argContains?: string
}

/** Result for the approval modal's "block this pattern" button. The
 *  label is built from the factor; the predicate is what gets stored
 *  in policy.yaml when the user taps it.
 *
 *  `actionId` is the stable button id used in the inline-keyboard
 *  callback_data (`fa:<actionId>:<approvalId>`). Naming: `block_` +
 *  factor rule name so the agent SOUL doesn't need a separate lookup
 *  table to know which custom action it's relaying. */
export interface FactorPredicateProposal {
  actionId: string
  label: string
  predicate: PredicateHint
  /** The factor rule name — surfaced in the policy.yaml comment block
   *  as the reason for the rule injection. */
  reason: string
}

/** Map a single risk factor + the request's args into a one-tap
 *  predicate proposal. Returns null when the factor doesn't have a
 *  clean predicate the modal can offer (e.g. structural factors like
 *  `first_agent_to_agent` aren't about a request shape — there's
 *  nothing to block by pattern). */
export function predicateHintForFactor(
  factor: RiskFactor,
  args: unknown,
  sourceAgent: string,
): FactorPredicateProposal | null {
  // ---------------------------------------------------------------
  // Secret-shaped factors — block by path pattern
  // ---------------------------------------------------------------
  if (factor.rule === 'secret_path' || factor.rule === 'secret_shape') {
    const path = extractPath(args)
    if (!path) return null
    const pattern = patternForSecretPath(path)
    if (!pattern) return null
    return {
      actionId: `block_${factor.rule}`,
      label: labelForPathBlock(pattern, sourceAgent),
      predicate: { pathMatch: [pattern] },
      reason: factor.rule,
    }
  }

  // ---------------------------------------------------------------
  // Shell-destructive factors — block by tool + command substring
  // ---------------------------------------------------------------
  // Shell rule ids start with `shell_` (e.g. shell_rm_rf_general,
  // shell_sudo). The factor's `evidence` typically contains the
  // matched command fragment; we use that as the argContains seed.
  if (factor.rule.startsWith('shell_')) {
    const command = extractCommand(args)
    if (!command) return null
    const fragment = shortestDistinguishingFragment(command, factor.rule)
    if (!fragment) return null
    return {
      actionId: `block_${factor.rule}`,
      label: `Block \`${fragment}\` commands from ${sourceAgent}`,
      predicate: { argContains: fragment },
      reason: factor.rule,
    }
  }

  // ---------------------------------------------------------------
  // Network-pattern factors — block by host substring
  // ---------------------------------------------------------------
  // Network rule ids start with `network_`. The factor's `evidence`
  // is the matched host / domain string in most cases (see
  // network-patterns.ts). Use it as the argContains seed; the host
  // sits in args as a URL, so substring match catches it regardless
  // of scheme / path.
  if (factor.rule.startsWith('network_')) {
    const host = factor.evidence?.trim()
    if (!host) return null
    // Skip the "safe host" advisory factor — we don't want to offer
    // "block google.com from hermes" as a UX option just because the
    // request mentioned it.
    if (factor.rule === 'network_safe_host') return null
    return {
      actionId: `block_${factor.rule}`,
      label: `Block \`${host}\` requests from ${sourceAgent}`,
      predicate: { argContains: host },
      reason: factor.rule,
    }
  }

  // Other factor categories (loop_*, structural like first_agent_to_agent,
  // responsibility_*, injection_*) don't translate cleanly to a request-
  // shaped predicate — they're either session-level or pattern-of-
  // patterns. Fall through; the modal shows just Allow / Deny.
  return null
}

/** Collect every proposal from a factor list, deduping by actionId in
 *  case two factors share a rule name (rare). The modal renders them
 *  as additional buttons alongside the standard Allow / Deny. */
export function predicateHintsForFactors(
  factors: readonly RiskFactor[],
  args: unknown,
  sourceAgent: string,
): FactorPredicateProposal[] {
  const seen = new Set<string>()
  const out: FactorPredicateProposal[] = []
  for (const f of factors) {
    const hint = predicateHintForFactor(f, args, sourceAgent)
    if (!hint) continue
    if (seen.has(hint.actionId)) continue
    seen.add(hint.actionId)
    out.push(hint)
  }
  return out
}

// ============================================================================
// Helpers — kept private; matched against the policy-engine extractors so
// the predicate the user accepts matches what `evaluate()` will check.
// ============================================================================

function extractPath(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null
  const path = (args as { path?: unknown }).path
  return typeof path === 'string' ? path : null
}

function extractCommand(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null
  const obj = args as { command?: unknown; args?: unknown }
  if (typeof obj.command === 'string') {
    if (Array.isArray(obj.args)) {
      return [obj.command, ...obj.args.map(String)].join(' ')
    }
    return obj.command
  }
  if (Array.isArray(obj.command)) {
    return obj.command.map(String).join(' ')
  }
  return null
}

/** Generalise a matched path into a tight regex pattern. ".env" alone
 *  becomes `^\.env(\..*)?$` so `.env`, `.env.local`, `.env.production`
 *  all match. Other secret-shaped paths (id_rsa, ssh keys) get
 *  basename-anchored patterns. */
function patternForSecretPath(path: string): string | null {
  const basename = path.split('/').pop()
  if (!basename) return null
  // Dotfile env families: .env, .env.local, .env.production, .envrc
  if (/^\.env(\..*)?$/.test(basename) || basename === '.envrc') {
    return '\\.env(\\..*)?$'
  }
  // Common private-key filenames — block exact matches for the family
  // (id_rsa, id_ed25519, id_ecdsa, etc.).
  if (/^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/.test(basename)) {
    return '/id_(rsa|ed25519|ecdsa|dsa)(\\.pub)?$'
  }
  // .pem / .key / .crt files — bare extension match, anchored.
  if (/\.(pem|key|crt|p12|pfx)$/.test(basename)) {
    return '\\.(pem|key|crt|p12|pfx)$'
  }
  // Fall back: anchor on the exact basename so the suggestion is at
  // least narrower than "any path".
  return `/${escapeRegex(basename)}$`
}

/** Pick a short, recognisable command fragment to seed the substring
 *  predicate from. `rm_rf` family → `"rm -rf"`; `sudo` family → `"sudo"`.
 *  Falls back to the first whitespace-delimited token of the command. */
function shortestDistinguishingFragment(
  command: string,
  rule: string,
): string | null {
  if (rule.includes('rm_rf')) return 'rm -rf'
  if (rule === 'shell_sudo' || rule.includes('sudo')) return 'sudo'
  if (rule.includes('dd')) return 'dd '
  if (rule.includes('mkfs')) return 'mkfs'
  if (rule.includes('chmod')) return 'chmod'
  if (rule.includes('chown')) return 'chown'
  if (rule.includes('shred')) return 'shred'
  if (rule.includes('fork_bomb')) return ':(){'
  const firstToken = command.trim().split(/\s+/)[0]
  return firstToken && firstToken.length > 0 ? firstToken : null
}

function labelForPathBlock(pattern: string, sourceAgent: string): string {
  // Translate the regex into a friendlier glob-ish label for the button.
  // We don't render the raw regex — users don't want to read `\\.env(\\..*)?$`
  // on a phone.
  if (pattern.includes('\\.env')) return `Block \`.env*\` reads from ${sourceAgent}`
  if (pattern.includes('id_')) return `Block SSH key reads from ${sourceAgent}`
  if (pattern.includes('pem')) return `Block private-key reads from ${sourceAgent}`
  return `Block this path pattern from ${sourceAgent}`
}

// Dash isn't a regex metacharacter outside character classes, so escapeRegex
// intentionally leaves it alone. Keep this consistent across the helper +
// any tests that pin the produced pattern string.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
