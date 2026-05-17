import {
  defaultVoiceConfig,
  loadVoiceConfig,
  saveVoiceConfig,
  type VoiceConfig,
} from "../core/notification/voice-config.js";

// =============================================================================
// Wizard → voice.yaml seed (#305)
// =============================================================================
//
// Sibling of setup-wizard-llm-persist.ts (#289) + setup-wizard-notify-persist.ts
// (#290). Seeds voice.yaml with sensible defaults after the services step so
// ForemanVoice (#303) + PatternDetectionService (#304) have a config file to
// read on first launch — no surprise "missing config" warnings from doctor.
//
// Idempotent: if voice.yaml already exists we load + merge so a user's hand
// edits survive a wizard re-run.

export interface BuildVoiceConfigInput {
  /** Existing voice.yaml content (loaded by caller). When the file doesn't
   *  exist yet this is the default config. */
  existing: VoiceConfig;
  /** Which notification channels the user wired in the services step. Used
   *  to gate which proactive types stay enabled — e.g. when telegram isn't
   *  configured, daily summary defaults to disabled rather than failing
   *  silently. */
  wiredChannels: readonly string[];
}

export interface BuildVoiceConfigResult {
  next: VoiceConfig;
  /** True when the proactive types got auto-disabled because no channel is
   *  configured (informational; the caller may surface this in the install
   *  log). */
  disabledForNoChannel: boolean;
}

/**
 * Build voice.yaml from wizard state. Pure — no FS access. The caller writes
 * the result via saveVoiceConfig.
 */
export function buildVoiceConfigFromWizard(
  input: BuildVoiceConfigInput,
): BuildVoiceConfigResult {
  const hasAnyChannel = input.wiredChannels.length > 0;
  if (hasAnyChannel) {
    // Channels are wired — keep the defaults (proactive types on). When
    // the existing voice.yaml has user overrides, those take precedence.
    return { next: input.existing, disabledForNoChannel: false };
  }
  // No notify channels — flip proactive types off so the user doesn't get
  // a 10-min pattern-detection tick that silently fails to send anywhere.
  const next: VoiceConfig = {
    ...input.existing,
    proactive_notifications: {
      ...input.existing.proactive_notifications,
      daily_summary: {
        ...input.existing.proactive_notifications.daily_summary,
        enabled: false,
      },
      weekly_summary: {
        ...input.existing.proactive_notifications.weekly_summary,
        enabled: false,
      },
      pattern_detection: {
        ...input.existing.proactive_notifications.pattern_detection,
        enabled: false,
      },
      agent_health_alerts: {
        ...input.existing.proactive_notifications.agent_health_alerts,
        enabled: false,
      },
      budget_alerts: {
        ...input.existing.proactive_notifications.budget_alerts,
        enabled: false,
      },
    },
  };
  return { next, disabledForNoChannel: true };
}

/** Side-effecting glue used by setup-wizard.tsx — best-effort, never crashes
 *  the wizard. */
export function persistVoiceConfig(
  path: string,
  wiredChannels: readonly string[],
): { wrote: boolean; disabledForNoChannel: boolean } {
  try {
    const existing = loadVoiceConfig(path);
    const { next, disabledForNoChannel } = buildVoiceConfigFromWizard({
      existing,
      wiredChannels,
    });
    saveVoiceConfig(path, next);
    return { wrote: true, disabledForNoChannel };
  } catch {
    // Fall back to writing defaults if the existing file is unparseable
    // — same pattern as the llm + notify persist helpers.
    try {
      saveVoiceConfig(path, defaultVoiceConfig());
      return { wrote: true, disabledForNoChannel: false };
    } catch {
      return { wrote: false, disabledForNoChannel: false };
    }
  }
}
