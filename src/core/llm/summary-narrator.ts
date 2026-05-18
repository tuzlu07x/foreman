import type { LlmClient } from "./client.js";
import { debugLogLlmError } from "./debug.js";
import type { SummaryStats } from "../notification/summary-generator.js";

// =============================================================================
// Smart summary narrator (#306)
// =============================================================================
//
// Replaces the template digest with an LLM-written narrative when LLM is
// enabled. The template stays as the fallback for: LLM disabled / budget
// exhausted / provider error / empty stats.
//
// Multilingual: defaults to English, switches to Turkish when locale=tr.
// Other locales fall through to English — the prompt is the same shape so
// adding more languages is just a translation pass on the system prompt.

export type SummaryLocale = "en" | "tr";

export interface BuildSummaryPromptInput {
  stats: SummaryStats;
  /** Window the stats cover (humanised — "12 hours", "24 hours", "3 days"). */
  windowLabel: string;
  /** Map agent id → declared responsibilityNote. Lets the LLM phrase
   *  things like "Hermes (code writing) tried to..." instead of bare ids. */
  responsibilities?: Record<string, string | null>;
  /** Optional budget snapshot — `{ spent, cap, alertTripped }`. When
   *  provided the LLM mentions cost only if it's meaningful (>50% of cap
   *  or alert tripped). */
  budget?: {
    spentUsd: number;
    capUsd: number;
    alertTripped?: boolean;
  };
  /** Topline factor counts (e.g. {secret_pattern: 4}) — drives "what
   *  happened" focus areas. */
  factorCounts?: Record<string, number>;
  locale?: SummaryLocale;
}

export interface NarrateSummaryInput extends BuildSummaryPromptInput {
  client: LlmClient;
  /** Max prompt tokens for the call. Default 600 (cheap on Haiku /
   *  gpt-4o-mini). */
  maxTokens?: number;
  /** Used to log timing — defaults to Date.now. */
  now?: () => number;
}

export type NarrateOutcome =
  | { status: "ok"; text: string; costUsd: number; durationMs: number }
  | { status: "skipped"; reason: "empty" }
  | { status: "failed"; reason: string };

const DEFAULT_MAX_TOKENS = 600;

/**
 * Build the LLM prompt for the summary narrator. Pure — caller decides
 * what to do with the string.
 */
export function buildSummaryPrompt(input: BuildSummaryPromptInput): string {
  const locale: SummaryLocale = input.locale ?? "en";
  const system = SYSTEM_PROMPT[locale];
  const data = renderStatsBlock(input);
  return [system, "", data].join("\n");
}

/**
 * Send the prompt to the LLM. Returns a narrate-outcome — caller folds
 * "failed" back to the template summary.
 */
export async function narrateSummary(
  input: NarrateSummaryInput,
): Promise<NarrateOutcome> {
  if (input.stats.totalCalls === 0) {
    // Nothing to talk about — template's "no news is good news" handles this.
    return { status: "skipped", reason: "empty" };
  }
  const prompt = buildSummaryPrompt(input);
  try {
    const res = await input.client.call(prompt, {
      feature: "summary",
      maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: 0.3,
    });
    const text = res.text.trim();
    if (text.length === 0) {
      return { status: "failed", reason: "empty model response" };
    }
    return {
      status: "ok",
      text,
      costUsd: res.costUsd,
      durationMs: res.durationMs,
    };
  } catch (err) {
    // #347 — opt-in stderr line so the user can diagnose smart-summary
    // fallback (FOREMAN_LLM_DEBUG=1). The reason is still kept on the
    // returned outcome for callers, but the TUI / digest pipeline doesn't
    // surface it.
    debugLogLlmError('summary', err);
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Detect locale from the LANG env var. Returns 'tr' for any Turkish locale
 * code (tr, tr_TR, tr_TR.UTF-8); 'en' otherwise. Future locales plug in
 * here.
 */
export function detectLocaleFromEnv(env: NodeJS.ProcessEnv = process.env): SummaryLocale {
  const lang = (env.LANG ?? env.LC_ALL ?? env.LC_MESSAGES ?? "").toLowerCase();
  if (lang.startsWith("tr")) return "tr";
  return "en";
}

// ----------------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------------

const SYSTEM_PROMPT: Record<SummaryLocale, string> = {
  en: `You are Foreman, a guardian for the user's local AI agents. The user
sees this report once a day. Write 4 short paragraphs (no headings, no
bullet points) covering, in order:

1. What stood out — notable events the user would miss by skimming.
2. Patterns — anything happening repeatedly across the window.
3. Cost — only mention if budget is unusually high (skip otherwise).
4. What's expected next — concrete next steps if any.

Speak as Foreman: direct, calm, one human voice. Refer to agents by id +
role when known ("Hermes (code writing)..."). Do NOT invent facts; if
the data is light, say so plainly. Keep total length under 250 words.`,

  tr: `Sen Foreman'sın, kullanıcının yerel AI ajanlarının koruyucusu. Bu
raporu kullanıcı günde bir kez görüyor. 4 kısa paragraf yaz (başlık
yok, madde işareti yok), şu sırayla:

1. Öne çıkanlar — kullanıcının göz gezdirirken kaçıracağı önemli
   olaylar.
2. Desenler — pencerede tekrar eden herhangi bir şey.
3. Maliyet — sadece bütçe alışılmadık derecede yüksekse bahset (yoksa
   atla).
4. Yarın için beklenen — varsa somut sonraki adımlar.

Foreman olarak konuş: direkt, sakin, tek insan sesi. Ajanlardan id +
rolüyle bahset ("Hermes (kod yazma)..."). Veriyi UYDURMA; veri azsa
bunu açıkça söyle. Toplam 250 kelimenin altında tut.`,
};

function renderStatsBlock(input: BuildSummaryPromptInput): string {
  const { stats, windowLabel, responsibilities, budget, factorCounts } = input;
  const lines: string[] = [`Window: ${windowLabel}`];
  lines.push(`Total tool calls: ${stats.totalCalls}`);
  lines.push(`Allowed: ${stats.decisionsAllowed}`);
  lines.push(`Denied: ${stats.decisionsDenied}`);
  lines.push(`High/critical risk: ${stats.highRiskCalls}`);
  lines.push(`Notifications delivered: ${stats.notificationsSent}`);
  if (stats.agentsActive.length > 0) {
    lines.push("");
    lines.push("Active agents:");
    for (const agent of stats.agentsActive) {
      const role = responsibilities?.[agent];
      lines.push(role ? `  - ${agent} (${role})` : `  - ${agent}`);
    }
  }
  if (factorCounts && Object.keys(factorCounts).length > 0) {
    lines.push("");
    lines.push("Risk factor counts:");
    const sorted = Object.entries(factorCounts).sort((a, b) => b[1] - a[1]);
    for (const [rule, count] of sorted) {
      lines.push(`  - ${rule}: ${count}`);
    }
  }
  if (budget) {
    const pct = budget.capUsd > 0
      ? Math.round((budget.spentUsd / budget.capUsd) * 100)
      : 0;
    lines.push("");
    lines.push(
      `Budget: $${budget.spentUsd.toFixed(2)} / $${budget.capUsd.toFixed(2)} (${pct}%${budget.alertTripped ? " — alert tripped" : ""})`,
    );
  }
  return lines.join("\n");
}
