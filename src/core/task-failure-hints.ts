import type { SpawnAgentTaskOutcome } from "./agent-spawn.js";

// =============================================================================
// Why a task failed, and what to do, in plain words
// =============================================================================
//
// 2.3.0 real test: a failed task sent the agent's whole stderr to Telegram
// (up to 50 000 characters), and the reason was somewhere inside. The
// result message now says the reason in one line and the fix in another,
// for the errors people actually hit, in the language the task was written
// in. Everything else falls back to the error's first line.

export type MessageLanguage = "en" | "tr";

const TURKISH_LETTERS = /[çğıöşüÇĞİÖŞÜ]/;
const TURKISH_WORDS = /\b(ve|bir|bu|için|ile|şu|projeyi|analiz|yap|et|edin|misin|lütfen|kanka|rapor|görev)\b/i;

/** The language to answer a task in: Turkish when the task reads Turkish. */
export function taskLanguage(task: string): MessageLanguage {
  return TURKISH_LETTERS.test(task) || TURKISH_WORDS.test(task) ? "tr" : "en";
}

export interface FailureExplanation {
  reason: string;
  /** What to do about it; null when there's nothing specific to say. */
  fix: string | null;
}

interface Known {
  test: RegExp;
  explain: (ctx: { runtime: string; program: string; agentId: string }) => Record<MessageLanguage, FailureExplanation>;
}

const KNOWN: readonly Known[] = [
  {
    test: /\b401\b|invalid[ _-]?(x-)?api[ _-]?key|failed to authenticate|authentication_error|not logged in|please (run )?.*login/i,
    explain: ({ runtime, program }) => {
      const login = runtime === "codex" ? "codex login" : "claude auth login";
      return {
        en: {
          reason: `${program} couldn't sign in (401).`,
          fix: `Sign in again with \`${login}\`. On a subscription, make sure no old API key is set for ${program}: \`foreman doctor\` shows it.`,
        },
        tr: {
          reason: `${program} giriş yapamadı (401).`,
          fix: `\`${login}\` ile tekrar giriş yap. Abonelik kullanıyorsan ${program} için eski bir API anahtarı kalmadığından emin ol: \`foreman doctor\` gösterir.`,
        },
      };
    },
  },
  {
    test: /usage limit|rate[ _-]?limit|\b429\b|quota|too many requests|overloaded/i,
    explain: ({ program }) => ({
      en: { reason: `${program} hit its usage limit.`, fix: "Try again later, or give the role a cheaper model: `/foreman model`." },
      tr: { reason: `${program} kullanım limitine takıldı.`, fix: "Biraz sonra tekrar dene ya da role daha ucuz bir model ver: `/foreman model`." },
    }),
  },
  {
    test: /unknown variant|model .*(not (found|supported|accessible|available)|does not exist)|not accessible|unsupported model|invalid model/i,
    explain: ({ runtime, program, agentId }) => ({
      en: {
        reason: `${program} can't use the model it was given: it's too old for it, or your account can't use it.`,
        fix: `Update it with \`foreman agent update ${runtime}\`, or pick another model: \`/foreman model ${agentId} clear\`.`,
      },
      tr: {
        reason: `${program} verilen modeli kullanamadı: sürümü eski ya da hesabın bu modele erişemiyor.`,
        fix: `\`foreman agent update ${runtime}\` ile güncelle ya da başka model seç: \`/foreman model ${agentId} clear\`.`,
      },
    }),
  },
  {
    test: /not inside a trusted directory|skip-git-repo-check/i,
    explain: ({ program }) => ({
      en: { reason: `${program} refused to work in that folder (not a trusted directory).`, fix: "Update Foreman: 2.3.1 and later give each role its own folder." },
      tr: { reason: `${program} o klasörde çalışmayı reddetti (güvenilir klasör değil).`, fix: "Foreman'ı güncelle: 2.3.1 ve sonrası her role kendi klasörünü verir." },
    }),
  },
  {
    test: /permission .*(hasn't been granted|not been granted|denied)|requires approval|haven't granted/i,
    explain: ({ program, agentId }) => ({
      en: {
        reason: `${program} stopped at its own permission prompt, which nobody can answer in a task.`,
        fix: `Let Foreman guard it instead: \`foreman agent hook install claude-code\`, or trust the role: \`foreman agent trust ${agentId}\`.`,
      },
      tr: {
        reason: `${program} kendi izin sorusunda durdu; görevde bunu cevaplayan kimse yok.`,
        fix: `Kontrolü Foreman'a ver: \`foreman agent hook install claude-code\`, ya da role güven: \`foreman agent trust ${agentId}\`.`,
      },
    }),
  },
  {
    test: /spawn \S+ ENOENT|command not found/i,
    explain: ({ program }) => ({
      en: { reason: `${program} isn't installed where Foreman looks for it.`, fix: "Install it, then check with `foreman doctor`." },
      tr: { reason: `${program}, Foreman'ın baktığı yerde kurulu değil.`, fix: "Kur, sonra `foreman doctor` ile kontrol et." },
    }),
  },
];

/** The reason and fix for a failed run, or null when it succeeded. */
export function explainTaskFailure(
  spawn: SpawnAgentTaskOutcome,
  who: { runtime: string; program: string; agentId: string },
  language: MessageLanguage,
): FailureExplanation | null {
  if (spawn.kind === "ok") return null;
  if (spawn.kind === "timeout") {
    const minutes = Math.max(1, Math.round(spawn.timeoutMs / 60_000));
    return language === "tr"
      ? { reason: `${minutes} dakikadan uzun sürdü, Foreman durdurdu.`, fix: "Daha küçük bir görev ver ya da ajanın task_timeout_seconds değerini artır." }
      : { reason: `It ran longer than ${minutes} min, so Foreman stopped it.`, fix: "Give it a smaller task, or raise the agent's task_timeout_seconds." };
  }
  if (spawn.kind === "unsupported") {
    return language === "tr"
      ? { reason: `${who.program} Foreman'dan görev alamıyor.`, fix: "İşi Claude Code ya da Codex üzerinde çalışan bir role ver." }
      : { reason: `${who.program} can't take tasks from Foreman.`, fix: "Give the work to a role on Claude Code or Codex." };
  }
  const text = spawn.kind === "spawn-error" ? spawn.error : `${spawn.stderr}\n${spawn.stdout}`;
  for (const known of KNOWN) {
    if (known.test.test(text)) return known.explain(who)[language];
  }
  const first = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const reason = first ? (first.length <= 200 ? first : `${first.slice(0, 199)}…`) : null;
  if (spawn.kind === "spawn-error") {
    return { reason: reason ?? (language === "tr" ? "Başlatılamadı." : "It could not be started."), fix: null };
  }
  return {
    reason: reason ?? (language === "tr" ? `${spawn.exitCode} koduyla çıktı.` : `It exited with code ${spawn.exitCode}.`),
    fix: null,
  };
}
