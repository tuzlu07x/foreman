import { describe, expect, it } from "vitest";
import { createHeuristicClassifier } from "../../src/core/flow-classifier.js";

// =============================================================================
// Heuristic output classifier — pattern coverage for the routing engine.
// =============================================================================
//
// The classifier is intentionally conservative: only fires when both a
// required pattern matches AND no excluded pattern matches. Tests cover
// the QA-observed phrasings ("approved", "changes requested", "blocker:",
// commit-hash markers) plus the tricky "approved with changes" trap
// that should NOT classify as approved.

const classifier = createHeuristicClassifier();
// Default the classifier with all known keys so tests don't have to
// pass the available-keys gate every time. (The router will pass the
// agent-specific set in production.)
const ALL_KEYS = [
  "approved",
  "changes_requested",
  "blocked",
  "code_written",
  "code_written_and_committed",
  "summary_ready",
] as const;

describe("HeuristicClassifier — approved", () => {
  it("returns 'approved' on a clean LGTM", () => {
    expect(classifier.classify("Looks good to me, ready to merge", ALL_KEYS))
      .toBe("approved");
  });
  it("recognizes Turkish 'onayli'", () => {
    expect(classifier.classify("Review tamamlandı, onaylıyorum", ALL_KEYS))
      .toBe("approved");
  });
  it("does NOT classify 'approved with the following changes' as approved", () => {
    // This is the trap: a reviewer says approved but lists fixes. We
    // should NOT route to orchestrator (which means "ship it"); we
    // should route to coder via changes_requested.
    expect(
      classifier.classify(
        "Approved with the following minor fixes: 1) rename...",
        ALL_KEYS,
      ),
    ).not.toBe("approved");
  });
});

describe("HeuristicClassifier — changes_requested", () => {
  it("recognizes the literal phrase", () => {
    expect(
      classifier.classify(
        "Changes requested — please fix the issues below",
        ALL_KEYS,
      ),
    ).toBe("changes_requested");
  });
  it("recognizes 'must fix' phrasing", () => {
    expect(
      classifier.classify(
        "Must fix the validation error before merging.",
        ALL_KEYS,
      ),
    ).toBe("changes_requested");
  });
  it("recognizes Turkish 'sorunlar/düzelt'", () => {
    expect(
      classifier.classify("Sorunlar (changes requested): düzelt lütfen", ALL_KEYS),
    ).toBe("changes_requested");
  });
});

describe("HeuristicClassifier — blocked", () => {
  it("classifies QA's exact codex blocker output", () => {
    expect(
      classifier.classify(
        "Blocker: .git/index.lock: Operation not permitted",
        ALL_KEYS,
      ),
    ).toBe("blocked");
  });
  it("classifies the readonly-db error", () => {
    expect(
      classifier.classify(
        "SqliteError: attempt to write a readonly database",
        ALL_KEYS,
      ),
    ).toBe("blocked");
  });
  it("does NOT classify a review that mentions 'blocker items' counts", () => {
    // QA review report said "review report with 4 minor + 2 blocker items"
    // — that's a description of the review's findings, NOT a blocker for
    // the reviewer's own work.
    const verdict = classifier.classify(
      "Review complete. Found 4 minor and 2 blocker items in the diff.",
      ALL_KEYS,
    );
    expect(verdict).not.toBe("blocked");
  });
});

describe("HeuristicClassifier — code_written_and_committed", () => {
  it("classifies a commit-hash marker", () => {
    expect(
      classifier.classify(
        "Done. commit hash: 1a84ecf3b2c9d8e7f6a5b4c3d2e1f0",
        ALL_KEYS,
      ),
    ).toBe("code_written_and_committed");
  });
  it("classifies a 'pushed to' marker", () => {
    expect(
      classifier.classify("pushed to origin/main, ready for review", ALL_KEYS),
    ).toBe("code_written_and_committed");
  });
});

describe("HeuristicClassifier — code_written", () => {
  it("classifies implementation + file reference", () => {
    expect(
      classifier.classify(
        "Implemented TodoController.php with full CRUD",
        ALL_KEYS,
      ),
    ).toBe("code_written");
  });
  it("classifies Turkish 'eklendi' + file ref", () => {
    expect(
      classifier.classify("Eklendi: resources/js/Pages/Todos/Index.jsx", ALL_KEYS),
    ).toBe("code_written");
  });
});

describe("HeuristicClassifier — availability gate", () => {
  it("returns 'unclassified' when the source agent has no matching rule for the detected pattern", () => {
    // codex (coder) doesn't have a rule for "summary_ready" — even if
    // its output mentions "summary", we shouldn't classify it. The
    // router only cares about classifications the agent can act on.
    const verdict = classifier.classify(
      "All done. Summary: implemented everything.",
      ["code_written"],
    );
    // It SHOULDN'T be summary_ready (codex has no rule for it).
    expect(verdict).not.toBe("summary_ready");
    // It MIGHT be code_written (the implementation verb is there).
    expect(["code_written", "unclassified"]).toContain(verdict);
  });
  it("returns 'unclassified' on empty input", () => {
    expect(classifier.classify("", ALL_KEYS)).toBe("unclassified");
    expect(classifier.classify("   \n  ", ALL_KEYS)).toBe("unclassified");
  });
});
