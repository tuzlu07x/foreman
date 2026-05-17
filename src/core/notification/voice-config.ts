import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

// =============================================================================
// voice.yaml — ForemanVoice + pattern-detection runtime config (#305)
// =============================================================================
//
// Lives at `<configDir>/voice.yaml`. Drives the proactive notification
// scaffolding from #303 + the pattern-detection ticker from #304:
//   - which proactive types are enabled
//   - per-type schedule / cooldown / threshold
//   - quiet hours (don't ping me overnight)
//
// Absent file = sensible defaults (most types on, summary at 20:00 local,
// quiet hours 23:00 → 08:00). The wizard's "voice" step writes this on
// fresh setup; the user can edit by hand later.

const ChannelIdSchema = z.enum([
  "telegram",
  "discord",
  "slack",
  "webhook",
  "system",
]);

const DailySummarySchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Local-time HH:MM. The scheduler reads `notify.yaml` routing.summary.schedule
     *  as the authoritative source today; this field shadows it so the wizard
     *  can write voice.yaml without touching notify.yaml. */
    schedule: z.string().default("20:00"),
    channel: ChannelIdSchema.default("telegram"),
  })
  .strict();

const WeeklySummarySchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Free-form "<Day> HH:MM" — parsed by the future weekly scheduler. */
    schedule: z.string().default("Sunday 09:00"),
    channel: ChannelIdSchema.default("telegram"),
  })
  .strict();

const PatternDetectionSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Minimum occurrences to call something a pattern. Mirrors the
     *  detector's `repeatedDenialMin`; future per-pattern overrides land
     *  in a separate field. */
    min_pattern_frequency: z.number().int().positive().default(3),
    /** Per-type cooldown — overrides ForemanVoice's built-in throttle for
     *  the pattern_detection type. */
    cooldown_minutes: z.number().int().nonnegative().default(60),
    channel: ChannelIdSchema.default("telegram"),
  })
  .strict();

const AgentHealthAlertsSchema = z
  .object({
    enabled: z.boolean().default(true),
    channel: ChannelIdSchema.default("telegram"),
  })
  .strict();

const BudgetAlertsSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Fire when usage crosses this % of the monthly cap. Mirrors
     *  llm.yaml.budget.alert_threshold_pct so the user has one knob if
     *  they only care about budget alerts. */
    threshold_percent: z.number().int().min(0).max(100).default(80),
    channel: ChannelIdSchema.default("telegram"),
  })
  .strict();

const ProactiveNotificationsSchema = z
  .object({
    daily_summary: DailySummarySchema.default({
      enabled: true,
      schedule: "20:00",
      channel: "telegram",
    }),
    weekly_summary: WeeklySummarySchema.default({
      enabled: false,
      schedule: "Sunday 09:00",
      channel: "telegram",
    }),
    pattern_detection: PatternDetectionSchema.default({
      enabled: true,
      min_pattern_frequency: 3,
      cooldown_minutes: 60,
      channel: "telegram",
    }),
    agent_health_alerts: AgentHealthAlertsSchema.default({
      enabled: true,
      channel: "telegram",
    }),
    budget_alerts: BudgetAlertsSchema.default({
      enabled: true,
      threshold_percent: 80,
      channel: "telegram",
    }),
  })
  .strict();

const QuietHoursSchema = z
  .object({
    enabled: z.boolean().default(true),
    from: z.string().default("23:00"),
    to: z.string().default("08:00"),
    /** Severity that overrides quiet hours. "critical" = critical messages
     *  still fire overnight; "none" = quiet hours are absolute. */
    exception: z.enum(["critical", "none"]).default("critical"),
  })
  .strict();

export const VoiceConfigSchema = z
  .object({
    proactive_notifications: ProactiveNotificationsSchema.default({
      daily_summary: {
        enabled: true,
        schedule: "20:00",
        channel: "telegram",
      },
      weekly_summary: {
        enabled: false,
        schedule: "Sunday 09:00",
        channel: "telegram",
      },
      pattern_detection: {
        enabled: true,
        min_pattern_frequency: 3,
        cooldown_minutes: 60,
        channel: "telegram",
      },
      agent_health_alerts: { enabled: true, channel: "telegram" },
      budget_alerts: {
        enabled: true,
        threshold_percent: 80,
        channel: "telegram",
      },
    }),
    quiet_hours: QuietHoursSchema.default({
      enabled: true,
      from: "23:00",
      to: "08:00",
      exception: "critical",
    }),
  })
  .strict();

export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;

/** Sensible defaults — used when voice.yaml is absent and when the wizard
 *  seeds the file for the first time. */
export function defaultVoiceConfig(): VoiceConfig {
  return VoiceConfigSchema.parse({});
}

export function loadVoiceConfig(path: string): VoiceConfig {
  if (!existsSync(path)) return defaultVoiceConfig();
  const raw = readFileSync(path, "utf-8");
  const parsed = raw.trim().length === 0 ? {} : (parseYaml(raw) as unknown);
  return VoiceConfigSchema.parse(mergeWithDefaults(parsed));
}

export function saveVoiceConfig(path: string, config: VoiceConfig): void {
  writeFileSync(path, stringifyYaml(config, { lineWidth: 120 }), "utf-8");
}

// ----------------------------------------------------------------------------
// Helpers consumed by ForemanVoice + PatternDetectionService at wire time.
// ----------------------------------------------------------------------------

/** Type discriminator used by ForemanVoice's throttle map. */
export type ProactiveTypeKey =
  | "daily_summary"
  | "weekly_summary"
  | "pattern_detection"
  | "agent_health"
  | "budget_alert";

/** Returns the per-type enabled flag — the dispatch loop early-exits
 *  when this is false so disabled types never reach NotificationService. */
export function isProactiveEnabled(
  cfg: VoiceConfig,
  type: ProactiveTypeKey,
): boolean {
  switch (type) {
    case "daily_summary":
      return cfg.proactive_notifications.daily_summary.enabled;
    case "weekly_summary":
      return cfg.proactive_notifications.weekly_summary.enabled;
    case "pattern_detection":
      return cfg.proactive_notifications.pattern_detection.enabled;
    case "agent_health":
      return cfg.proactive_notifications.agent_health_alerts.enabled;
    case "budget_alert":
      return cfg.proactive_notifications.budget_alerts.enabled;
  }
}

function mergeWithDefaults(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return defaultVoiceConfig();
  const defaults = defaultVoiceConfig();
  const obj = input as Record<string, unknown>;
  return {
    ...defaults,
    ...obj,
    proactive_notifications: {
      ...defaults.proactive_notifications,
      ...((obj.proactive_notifications as Record<string, unknown>) ?? {}),
    },
    quiet_hours: {
      ...defaults.quiet_hours,
      ...((obj.quiet_hours as Record<string, unknown>) ?? {}),
    },
  };
}
