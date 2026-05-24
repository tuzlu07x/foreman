// =============================================================================
// Heuristic output classifier for the flow router.
// =============================================================================
//
// Phase A: regex matchers on the captured agent stdout. The classifier
// receives the raw output text + the keys of the source agent's
// `handoff_rules` (so we only return classifications the agent
// actually has a routing rule for). Returns the first matching
// classification or "unclassified" if none hit.
//
// Phase B (separate PR) replaces this with an LLM-based classifier that
// shares the same interface. The router calls `classify(output, rules)`
// — swap-out is single line. Until then this heuristic covers the
// common cases observed in QA: review verdicts (approved / changes
// requested / blocked) and implementer outputs (code written,
// committed, pushed).

export type Classification =
  | "approved"
  | "changes_requested"
  | "blocked"
  | "code_written"
  | "code_written_and_committed"
  | "summary_ready"
  | "unclassified";

export interface OutputClassifier {
  classify(output: string, availableKeys: readonly string[]): Classification;
}

interface HeuristicRule {
  classification: Classification;
  // ALL patterns must match for the classification to fire. Conjunctive
  // matching tightens accuracy — "approved" alone is too generic, but
  // "approved" + (no "but" / no "however") is more reliable.
  required: RegExp[];
  // ANY of these disqualifies the match. Lets us distinguish "approved
  // pending fixes" from "approved".
  excluded?: RegExp[];
}

// Order matters: stricter classifications first so "approved" doesn't
// shadow "changes_requested" when the review says "approved with the
// following changes".
const RULES: HeuristicRule[] = [
  // "Blocked" / hard failure — implementer couldn't finish at all.
  {
    classification: "blocked",
    required: [
      /\b(blocker|blocked|cannot|unable to|permission denied|operation not permitted|readonly|read-only)\b/i,
    ],
    // Don't classify a review that mentions "blocker:" as a list item
    // unless the implementer themselves is blocked. A review saying
    // "Blockers: none" or "1 minor + 2 blocker items" is NOT a blocker
    // outcome for the reviewer's own work.
    excluded: [/blocker items|blockers:\s*none|0\s+blocker/i],
  },

  // "Changes requested" — review wants fixes. Heuristic: review-style
  // markers + at least one corrective verb. Matches the QA review
  // output: "## ⚠️ Sorunlar (changes requested)" etc.
  {
    classification: "changes_requested",
    required: [
      /\b(changes\s*requested|request\s*changes|please\s*fix|must\s*fix|needs?\s*to\s*be\s*(fixed|changed|addressed)|sorunlar|d[üu]zelt|fix the following|requested changes)\b/i,
    ],
  },

  // "Approved" — review accepted. Common phrasings + emojis.
  {
    classification: "approved",
    required: [
      /\b(approved|lgtm|looks good to me|ready to merge|onayl[ıi]|kabul|ship it)\b/i,
    ],
    excluded: [
      // "approved with X changes" or "approved if Y" → that's actually changes_requested
      /\bapproved\b.*\b(with|if|provided|once|after)\s+(the\s+)?(following|change|fix)/i,
    ],
  },

  // "Code written and committed" — implementer succeeded end-to-end:
  // produced commit + push artifact. Strict markers.
  {
    classification: "code_written_and_committed",
    required: [
      /\b(commit\s*hash|pushed to|git push|commit:?\s*[a-f0-9]{7,40}|merged to)\b/i,
    ],
  },

  // "Code written" — implementer produced files but no commit visible.
  // Triggers on file lists + implementation verbs. Common in the QA
  // codex output ("Eklenen ana kapsam: ... TodoController.php ...").
  {
    classification: "code_written",
    required: [
      // Implementation verb.
      /\b(implement(ed|asyon)?|wrote|added|created|tamamlad[ıi]|eklendi|hazır)\b/i,
      // File reference — path or filename.
      /[\w/.-]+\.(ts|tsx|js|jsx|py|php|go|rs|rb|java|md|sql|yml|yaml|json)\b/i,
    ],
  },

  // "Summary ready" — orchestrator finished synthesizing. Used at the
  // top of the flow when hermes wraps up.
  {
    classification: "summary_ready",
    required: [
      /\b(summary|özet|final\s*report|flow\s*complete|all\s*done|tamamland[ıi]\s*✓?)\b/i,
    ],
  },
];

class HeuristicClassifier implements OutputClassifier {
  classify(output: string, availableKeys: readonly string[]): Classification {
    if (!output || output.trim().length === 0) {
      return "unclassified";
    }
    const keysSet = new Set(availableKeys);
    for (const rule of RULES) {
      // Skip rules whose classification the source agent has no rule
      // for — saves work + prevents false positives leaking into a
      // routing path the operator never declared.
      if (availableKeys.length > 0 && !keysSet.has(rule.classification)) {
        continue;
      }
      const requiredOk = rule.required.every((re) => re.test(output));
      if (!requiredOk) continue;
      const excludedHit = (rule.excluded ?? []).some((re) => re.test(output));
      if (excludedHit) continue;
      return rule.classification;
    }
    return "unclassified";
  }
}

export function createHeuristicClassifier(): OutputClassifier {
  return new HeuristicClassifier();
}
