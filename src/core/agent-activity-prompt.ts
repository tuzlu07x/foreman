import type { AgentActivityDigest } from "./agent-activity-summary.js";

// =============================================================================
// Activity digest → LLM prompt (#435)
// =============================================================================
//
// Renders the structured digest into a tight system-style prompt the
// Foreman LLM can narrate. Style matches the orchestrator chat prompt
// (#432): plain-text 1-3 paragraph reply, language-matched. Keeps
// numbers + names exact so the LLM doesn't hallucinate counts.

export interface BuildActivityPromptArgs {
  digest: AgentActivityDigest;
  /** Optional preface — for daily summary triggers, set to
   *  "Generate the daily summary for the user." For ad-hoc CLI use,
   *  pass the user's actual question or leave undefined for the default. */
  question?: string;
  /** Force locale. Defaults to "en"; daily trigger may pass "tr" based
   *  on the user's notify.yaml locale setting. */
  locale?: "en" | "tr";
}

const DEFAULTS = {
  en: "Summarize what the agents did in the window above. Mention idle agents, notable denials or crashes, and any budget alerts.",
  tr: "Yukarıdaki pencerede agent'lar ne yaptı, özetle. Bos durmuş agent'ları, dikkat çeken deny/crash'leri, varsa bütçe uyarılarını belirt.",
};

export function buildActivityPrompt(args: BuildActivityPromptArgs): string {
  const locale = args.locale ?? "en";
  const d = args.digest;
  const windowMin = Math.max(
    1,
    Math.round((d.window.end - d.window.start) / 60_000),
  );
  const capturedAt = new Date(d.window.end).toISOString();
  const question = args.question?.trim().length
    ? args.question.trim()
    : DEFAULTS[locale];

  const agentLines = d.agents.map((a) => {
    const last = a.lastActivityAt
      ? `last activity ${describeAgo(d.window.end - a.lastActivityAt)}`
      : "idle";
    return `  - ${a.id} (${a.displayName}): ${a.requestCount} requests · ${a.deniedCount} denied · ${last}`;
  });

  const sessionLines = d.sessions.slice(0, 10).map((s) => {
    return `  - ${s.id} (${s.status}, ${s.participants.join(" + ")}, ${s.messageCount} msgs / ${s.tokenCount} tokens)`;
  });

  const notableLines = d.notableEvents.map((e) => {
    const ago = describeAgo(d.window.end - e.when);
    return `  - ${ago}: [${e.kind}] ${e.summary}`;
  });

  return [
    "You are Foreman — a guardian that supervises a small team of AI agents.",
    "Summarize agent activity for the user. Reply in 1-3 short paragraphs,",
    "plain text (no markdown headers, no lists). Match the user's language",
    "(Turkish if the question is Turkish, English otherwise). Use the exact",
    "numbers + agent ids from the snapshot — don't round or invent.",
    "",
    `Window: ${windowMin} minute(s) ending at ${capturedAt}.`,
    "",
    `Agents (${d.agents.length}):`,
    agentLines.length > 0 ? agentLines.join("\n") : "  (none registered)",
    "",
    `Sessions started in window (${d.sessions.length}):`,
    sessionLines.length > 0 ? sessionLines.join("\n") : "  (none)",
    "",
    `Notable events (${d.notableEvents.length}):`,
    notableLines.length > 0 ? notableLines.join("\n") : "  (none)",
    "",
    "User's question:",
    question,
    "",
    "Your reply:",
  ].join("\n");
}

function describeAgo(ms: number): string {
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
