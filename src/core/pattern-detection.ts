import type { Request } from "../db/schema.js";

// =============================================================================
// Pattern detection v1 (#304)
// =============================================================================
//
// First concrete consumer of ForemanVoice (#303). Looks at the recent audit
// log and surfaces multi-event patterns the user would otherwise have to
// piece together by reading the logs themselves:
//
//   - repeated-denial: same agent + target + tool denied N+ times → "block
//     it permanently?"
//   - repeated-allow: same trio allowed N+ times → "auto-allow this?"
//   - burst: >M requests from one agent in a short window → suggest a
//     rate_limit policy
//   - off-responsibility cluster: agent fires the responsibility-violation
//     rule N+ times → "tighten the role's policy"
//
// Pure module: takes rows in, returns DetectedPattern[]. The scheduler /
// trigger wiring lives in pattern-detection-service.ts. The button-press
// → policy.addRule plumbing is reserved for #305 (the action-button id
// schema needs to land alongside voice.yaml); v1 ships the alert + the
// CLI hint the user can paste manually.

export type DetectedPatternKind =
  | "repeated_denial"
  | "repeated_allow"
  | "burst"
  | "off_responsibility_cluster";

export interface DetectedPattern {
  kind: DetectedPatternKind;
  /** Stable key — same {kind, key} dedupes within a cooldown window so we
   *  don't re-alert about the same pattern every tick. */
  key: string;
  /** Source agent the pattern is about. */
  sourceAgent: string;
  /** Aggregated count over the window. */
  count: number;
  /** Window the count was measured over, in ms. */
  windowMs: number;
  /** Optional pattern-specific extras — the suggester reads these to build
   *  a concrete rule recommendation. */
  detail: PatternDetail;
}

export type PatternDetail =
  | { kind: "repeated_denial" | "repeated_allow"; targetAgent: string | null; targetTool: string | null }
  | { kind: "burst"; perMinute: number }
  | { kind: "off_responsibility_cluster"; ruleHits: number };

export interface DetectorThresholds {
  /** N+ denials of the same target → suggest auto-deny. */
  repeatedDenialMin: number;
  /** N+ allowed of the same target → suggest auto-allow. */
  repeatedAllowMin: number;
  /** Request count threshold inside `burstWindowMs` to call it a burst. */
  burstMin: number;
  /** Window for the burst check. */
  burstWindowMs: number;
  /** Window for repeated-denial / repeated-allow counts. */
  repeatedWindowMs: number;
  /** N+ responsibility_violation factor hits inside the same window. */
  offResponsibilityMin: number;
}

export const DEFAULT_THRESHOLDS: DetectorThresholds = {
  repeatedDenialMin: 3,
  repeatedAllowMin: 5,
  burstMin: 10,
  burstWindowMs: 60_000, // 1 minute
  repeatedWindowMs: 60 * 60 * 1000, // 1 hour
  offResponsibilityMin: 3,
};

/**
 * Walk the audit rows and emit every pattern that crosses the threshold.
 * Pure — no DB / bus / clock access (caller supplies `nowMs` for deterministic
 * tests + so the same fn drives both production and historical replays).
 */
export function detectPatterns(
  rows: readonly Request[],
  nowMs: number,
  thresholds: DetectorThresholds = DEFAULT_THRESHOLDS,
): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];
  const cutoffRepeated = nowMs - thresholds.repeatedWindowMs;
  const cutoffBurst = nowMs - thresholds.burstWindowMs;

  // --- repeated denial / repeated allow ---------------------------------
  const decisionGroups = new Map<
    string,
    { source: string; target: string | null; tool: string | null; count: number; decision: "allowed" | "denied" }
  >();
  for (const r of rows) {
    if (r.createdAt < cutoffRepeated) continue;
    if (r.decision !== "allowed" && r.decision !== "denied") continue;
    const key = `${r.decision}|${r.sourceAgent}|${r.targetAgent ?? "_"}|${r.targetTool ?? "_"}`;
    const slot = decisionGroups.get(key);
    if (slot) {
      slot.count += 1;
    } else {
      decisionGroups.set(key, {
        source: r.sourceAgent,
        target: r.targetAgent,
        tool: r.targetTool,
        count: 1,
        decision: r.decision,
      });
    }
  }
  for (const [key, g] of decisionGroups) {
    if (g.decision === "denied" && g.count >= thresholds.repeatedDenialMin) {
      patterns.push({
        kind: "repeated_denial",
        key,
        sourceAgent: g.source,
        count: g.count,
        windowMs: thresholds.repeatedWindowMs,
        detail: {
          kind: "repeated_denial",
          targetAgent: g.target,
          targetTool: g.tool,
        },
      });
    }
    if (g.decision === "allowed" && g.count >= thresholds.repeatedAllowMin) {
      patterns.push({
        kind: "repeated_allow",
        key,
        sourceAgent: g.source,
        count: g.count,
        windowMs: thresholds.repeatedWindowMs,
        detail: {
          kind: "repeated_allow",
          targetAgent: g.target,
          targetTool: g.tool,
        },
      });
    }
  }

  // --- burst (per-agent request rate) -----------------------------------
  const burstCounts = new Map<string, number>();
  for (const r of rows) {
    if (r.createdAt < cutoffBurst) continue;
    burstCounts.set(r.sourceAgent, (burstCounts.get(r.sourceAgent) ?? 0) + 1);
  }
  for (const [agent, count] of burstCounts) {
    if (count >= thresholds.burstMin) {
      patterns.push({
        kind: "burst",
        key: `burst|${agent}`,
        sourceAgent: agent,
        count,
        windowMs: thresholds.burstWindowMs,
        detail: {
          kind: "burst",
          perMinute: Math.round((count / thresholds.burstWindowMs) * 60_000),
        },
      });
    }
  }

  // --- off-responsibility cluster ---------------------------------------
  const respCounts = new Map<string, number>();
  for (const r of rows) {
    if (r.createdAt < cutoffRepeated) continue;
    if (!r.riskFactors) continue;
    if (!hasResponsibilityViolation(r.riskFactors)) continue;
    respCounts.set(r.sourceAgent, (respCounts.get(r.sourceAgent) ?? 0) + 1);
  }
  for (const [agent, count] of respCounts) {
    if (count >= thresholds.offResponsibilityMin) {
      patterns.push({
        kind: "off_responsibility_cluster",
        key: `off_resp|${agent}`,
        sourceAgent: agent,
        count,
        windowMs: thresholds.repeatedWindowMs,
        detail: {
          kind: "off_responsibility_cluster",
          ruleHits: count,
        },
      });
    }
  }

  return patterns;
}

/**
 * Build the human-readable proactive message body for a detected pattern.
 * Includes the suggested CLI command so the user can apply the rule from
 * Telegram-side reading + paste — the interactive "apply" button arrives
 * in #305 once the voice.yaml + action callback schema lands.
 */
export function describePattern(p: DetectedPattern): {
  title: string;
  body: string;
} {
  switch (p.kind) {
    case "repeated_denial": {
      const target = renderTarget(p.detail);
      return {
        title: `Repeated denial — ${p.sourceAgent} → ${target}`,
        body:
          `${p.sourceAgent} attempted ${target} ${p.count} times in the last ` +
          `${Math.round(p.windowMs / 60_000)} minutes and you denied every one.` +
          `\n\nSuggestion: block it permanently with a policy rule.` +
          `\n  $ foreman policy add --source "${p.sourceAgent}" --target "${target}" --effect deny`,
      };
    }
    case "repeated_allow": {
      const target = renderTarget(p.detail);
      return {
        title: `Repeated allow — ${p.sourceAgent} → ${target}`,
        body:
          `${p.sourceAgent} did ${target} ${p.count} times in the last ` +
          `${Math.round(p.windowMs / 60_000)} minutes and you allowed every one.` +
          `\n\nSuggestion: auto-allow so you stop seeing the prompt.` +
          `\n  $ foreman policy add --source "${p.sourceAgent}" --target "${target}" --effect allow`,
      };
    }
    case "burst": {
      const detail = p.detail.kind === "burst" ? p.detail : null;
      const rate = detail?.perMinute ?? p.count;
      return {
        title: `Burst — ${p.sourceAgent} at ${rate}/min`,
        body:
          `${p.sourceAgent} sent ${p.count} requests in the last ` +
          `${Math.round(p.windowMs / 1000)} seconds (~${rate}/min).` +
          `\n\nSuggestion: set a per-minute rate limit.` +
          `\n  $ foreman policy add --source "${p.sourceAgent}" --rate-limit 30/min`,
      };
    }
    case "off_responsibility_cluster": {
      return {
        title: `Off-responsibility cluster — ${p.sourceAgent}`,
        body:
          `${p.sourceAgent} tripped the responsibility-violation rule ${p.count} times ` +
          `in the last hour. Its declared role doesn't cover what it's been asked to do.` +
          `\n\nSuggestion: tighten the responsibility_policies block in policy.yaml ` +
          `or update the agent's responsibility note via foreman agent edit.`,
      };
    }
  }
}

function renderTarget(
  detail: PatternDetail,
): string {
  if (detail.kind !== "repeated_denial" && detail.kind !== "repeated_allow") {
    return "<unknown>";
  }
  const tool = detail.targetTool ?? "?";
  const agent = detail.targetAgent;
  return agent ? `${agent}:${tool}` : tool;
}

function hasResponsibilityViolation(riskFactorsJson: string): boolean {
  try {
    const parsed = JSON.parse(riskFactorsJson) as Array<{ rule?: string }>;
    if (!Array.isArray(parsed)) return false;
    return parsed.some(
      (f) =>
        typeof f.rule === "string" &&
        f.rule.startsWith("responsibility_violation"),
    );
  } catch {
    return false;
  }
}
