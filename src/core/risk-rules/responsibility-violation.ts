import { extractPath, type RiskFactor, type RiskRule } from './types.js'

// =============================================================================
// Responsibility-violation rule (#300)
// =============================================================================
//
// Consumes the responsibility_policies block from #299 and scores actions
// that fall outside the source agent's declared role. Three flavours:
//
//   1. cannot_access — agent is reading/writing a path the role forbids.
//      Example: Hermes (code writing) opens ~/.ssh/id_rsa → +60.
//   2. cannot_call_agents_with_responsibility — agent is delegating to
//      another agent whose role is in the don't-talk-to list.
//      Example: a "code writing" agent invokes a "payment processing"
//      agent → +50.
//   3. can_use_services (allowlist semantics) — agent is calling out to a
//      service id that isn't in the role's whitelist.
//      Example: a "code writing" agent posts to telegram when its role
//      only whitelists [github] → +40.
//
// All three are advisory: they bump the score but don't auto-deny. The
// approval modal and Telegram alert carry the role mismatch in the
// reason text so the user sees "outside Hermes's role: code writing" in
// human language. The decision is still the user's.

// Known service ids that map 1:1 to registry/services.json. Used to detect
// "this targetAgent is actually a service" for the can_use_services check.
// Kept in sync with the catalog by hand for now; if this grows we'll source
// from loadActiveServices() at scorer construction time.
const KNOWN_SERVICE_IDS = new Set([
  'telegram',
  'discord',
  'slack',
  'github',
  'atlassian',
  'jira',
  'notion',
  'webhook',
])

export const responsibilityViolationRule: RiskRule = {
  name: 'responsibility_violation',
  category: 'structural',
  evaluate(req, ctx): RiskFactor[] {
    // Context not wired (test harness, legacy entry point) → no-op cleanly.
    if (!ctx.getAgentResponsibility || !ctx.responsibilityPolicies) return []

    const sourceResponsibility = ctx.getAgentResponsibility(req.sourceAgent)
    if (!sourceResponsibility) return []

    const policies = ctx
      .responsibilityPolicies()
      .filter(
        (p) =>
          p.responsibility.toLowerCase() ===
          sourceResponsibility.toLowerCase(),
      )
    if (policies.length === 0) return []

    const factors: RiskFactor[] = []
    const path = extractPath(req.args)

    for (const policy of policies) {
      // -- cannot_access (path-based) ---------------------------------------
      if (path && policy.cannot_access) {
        for (const pattern of policy.cannot_access) {
          if (matchesPathPattern(pattern, path)) {
            factors.push({
              rule: 'responsibility_violation',
              category: 'structural',
              points: 60,
              reason: `this is outside ${req.sourceAgent}'s declared role ("${sourceResponsibility}") — that role can't access ${pattern}`,
              evidence: path,
            })
            break // one cannot_access hit is enough per policy
          }
        }
      }

      // -- cannot_call_agents_with_responsibility ---------------------------
      if (
        req.targetAgent &&
        policy.cannot_call_agents_with_responsibility &&
        ctx.getAgentResponsibility
      ) {
        const targetResp = ctx.getAgentResponsibility(req.targetAgent)
        if (targetResp) {
          const matched = policy.cannot_call_agents_with_responsibility.find(
            (r) => r.toLowerCase() === targetResp.toLowerCase(),
          )
          if (matched) {
            factors.push({
              rule: 'responsibility_violation_delegation',
              category: 'structural',
              points: 50,
              reason: `${req.sourceAgent}'s role ("${sourceResponsibility}") is not allowed to delegate to ${req.targetAgent} (role "${targetResp}")`,
              evidence: `${req.sourceAgent} → ${req.targetAgent}`,
            })
          }
        }
      }

      // -- can_use_services (allowlist) -------------------------------------
      if (req.targetAgent && policy.can_use_services) {
        const target = req.targetAgent.toLowerCase()
        if (
          KNOWN_SERVICE_IDS.has(target) &&
          !policy.can_use_services.some((s) => s.toLowerCase() === target)
        ) {
          factors.push({
            rule: 'responsibility_violation_service',
            category: 'structural',
            points: 40,
            reason: `${req.sourceAgent}'s role ("${sourceResponsibility}") is not allowed to use the ${req.targetAgent} service (allowed: ${policy.can_use_services.join(', ')})`,
            evidence: req.targetAgent,
          })
        }
      }
    }
    return factors
  },
}

// Path matching — the policy.yaml stores raw regex strings (same convention
// as the rules block's pathMatch). Invalid regex degrades silently to a
// substring contains() so a malformed policy doesn't crash the mediator.
function matchesPathPattern(pattern: string, path: string): boolean {
  try {
    return new RegExp(pattern).test(path)
  } catch {
    return path.includes(pattern)
  }
}
