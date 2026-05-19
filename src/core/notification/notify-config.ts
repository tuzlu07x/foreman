import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'
import type { NotificationLevel } from './types.js'

// ============================================================================
// Schema — `~/.foreman/notify.yaml`
// ============================================================================

const ChannelToggleSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Reference to a key in Foreman's secret store. */
    bot_token_ref: z.string().optional(),
    /** Telegram chat_id (string to preserve large numeric ids). */
    chat_id: z.string().optional(),
    /** Webhook destination URL — stored as a secret ref so the URL itself is
     *  encrypted at rest (URLs often embed auth tokens). */
    webhook_url_ref: z.string().optional(),
    /** Optional HMAC-SHA256 signing secret (secret ref). When set, every
     *  webhook POST carries a `X-Foreman-Signature` header receivers can
     *  verify. */
    signing_secret_ref: z.string().optional(),
    /** Slack channel name + bot token ref. */
    channel: z.string().optional(),
  })
  .strict()

const RouteSchema = z
  .object({
    channels: z.array(z.string()).default([]),
    timeout_seconds: z.number().int().nonnegative().default(0),
    default_action: z.enum(['allow', 'deny']).default('deny'),
    /** Cron-ish for summary level. */
    schedule: z.string().optional(),
  })
  .strict()

export const NotifyConfigSchema = z
  .object({
    channels: z
      .object({
        telegram: ChannelToggleSchema.optional(),
        discord: ChannelToggleSchema.optional(),
        slack: ChannelToggleSchema.optional(),
        webhook: ChannelToggleSchema.optional(),
        system: ChannelToggleSchema.optional(),
      })
      .default({}),
    routing: z
      .object({
        critical: RouteSchema.optional(),
        warning: RouteSchema.optional(),
        info: RouteSchema.optional(),
        summary: RouteSchema.optional(),
        budget_alert: RouteSchema.optional(),
        /** Auto-deny alert (#383). When the risk engine auto-denies a call
         *  (high-risk pattern caught — typical: secret_path, prompt_injection),
         *  fire a notification on these channels. Different from `critical`
         *  which routes APPROVAL requests; this routes after-the-fact alerts
         *  for things the user never had a chance to see. */
        risk_deny: RouteSchema.optional(),
        /** #435 — Periodic "what did the agents do in the last 24h" LLM
         *  narration. Distinct from `summary` (which is the C9 daily
         *  digest). Off by default: leave channels empty or omit the
         *  route entirely. Enable with e.g.
         *  `activity_summary: { channels: ['telegram'], schedule: 'daily 20:00' }`.
         *  Requires `features.orchestrator_chat: true` in llm.yaml. */
        activity_summary: RouteSchema.optional(),
      })
      .default({}),
  })
  .strict()

export type NotifyConfig = z.infer<typeof NotifyConfigSchema>
export type ChannelToggle = z.infer<typeof ChannelToggleSchema>
export type Route = z.infer<typeof RouteSchema>

// ============================================================================
// Defaults — sane out-of-the-box config
// ============================================================================

export function defaultNotifyConfig(): NotifyConfig {
  return NotifyConfigSchema.parse({
    channels: {
      telegram: { enabled: false },
    },
    routing: {
      critical: {
        channels: ['telegram'],
        timeout_seconds: 300,
        default_action: 'deny',
      },
      warning: { channels: ['telegram'], timeout_seconds: 0 },
      info: { channels: [], timeout_seconds: 0 },
      summary: { channels: ['telegram'], timeout_seconds: 0, schedule: 'daily 20:00' },
      budget_alert: { channels: ['telegram'], timeout_seconds: 0 },
      // #383 — auto-deny alerts ("Foreman caught X attempting Y") default
      // to telegram so the user knows their guardian is actually working.
      risk_deny: { channels: ['telegram'], timeout_seconds: 0 },
    },
  })
}

// ============================================================================
// Load + save
// ============================================================================

export function loadNotifyConfig(path: string): NotifyConfig {
  if (!existsSync(path)) return defaultNotifyConfig()
  const raw = readFileSync(path, 'utf-8')
  const parsed = raw.trim().length === 0 ? {} : (parseYaml(raw) as unknown)
  // Merge with defaults so missing keys don't crash.
  const merged = mergeWithDefaults(parsed)
  return NotifyConfigSchema.parse(merged)
}

export function saveNotifyConfig(path: string, config: NotifyConfig): void {
  const yaml = stringifyYaml(config, { lineWidth: 120 })
  writeFileSync(path, yaml, 'utf-8')
}

function mergeWithDefaults(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return defaultNotifyConfig()
  const defaults = defaultNotifyConfig()
  const obj = input as Record<string, unknown>
  return {
    channels: {
      ...defaults.channels,
      ...((obj.channels as Record<string, unknown>) ?? {}),
    },
    routing: {
      ...defaults.routing,
      ...((obj.routing as Record<string, unknown>) ?? {}),
    },
  }
}

// ============================================================================
// Accessors used by NotificationService + CLI
// ============================================================================

export function routeFor(
  config: NotifyConfig,
  level: NotificationLevel,
): Route {
  const r = config.routing[level]
  return r ?? { channels: [], timeout_seconds: 0, default_action: 'deny' }
}

export function isChannelEnabled(
  config: NotifyConfig,
  channelId: string,
): boolean {
  const ch = (config.channels as Record<string, ChannelToggle | undefined>)[
    channelId
  ]
  return ch?.enabled === true
}

export function channelConfig(
  config: NotifyConfig,
  channelId: string,
): ChannelToggle | null {
  return (
    (config.channels as Record<string, ChannelToggle | undefined>)[channelId] ??
    null
  )
}
