import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'

// ============================================================================
// LLM provider config (#230 / C7)
// ============================================================================
//
// Lives at `<configDir>/llm.yaml`. Global kill-switch + per-feature opt-in +
// budget guardrails + per-provider secret refs. No literal API keys ever land
// in this file — credentials are stored in Foreman's encrypted secret store
// and referenced by name.

export const ProviderIdSchema = z.enum([
  'anthropic',
  'openai',
  'gemini',
  'ollama',
  'openai_compatible',
])
export type ProviderId = z.infer<typeof ProviderIdSchema>

const FeaturesSchema = z
  .object({
    verification: z.boolean().default(false),
    smart_report: z.boolean().default(false),
    policy_suggestions: z.boolean().default(false),
    /** #432 — Orchestrator-chat feature. When on, `/foreman report me`,
     *  `/foreman <agent> ne yapıyor`, and free-form `/foreman <text>`
     *  go through Foreman's LLM to produce natural-language replies.
     *  Off by default so users opt in to the budget consumption. */
    orchestrator_chat: z.boolean().default(false),
  })
  .strict()

const BudgetSchema = z
  .object({
    monthly_cap_usd: z.number().positive().default(5),
    alert_threshold_pct: z.number().int().min(0).max(100).default(80),
    reset_day_of_month: z.number().int().min(1).max(28).default(1),
  })
  .strict()

const CredentialBlockSchema = z
  .object({
    secret_name: z.string().nullable().optional(),
    endpoint: z.string().optional(),
    endpoint_secret: z.string().optional(),
    key_secret: z.string().optional(),
  })
  .strict()

const CredentialsSchema = z
  .object({
    anthropic: CredentialBlockSchema.optional(),
    openai: CredentialBlockSchema.optional(),
    gemini: CredentialBlockSchema.optional(),
    ollama: CredentialBlockSchema.optional(),
    openai_compatible: CredentialBlockSchema.optional(),
  })
  .strict()

export const LlmConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: ProviderIdSchema.default('anthropic'),
    // Free-form so the user can pick any model the provider supports; we
    // pricing-validate at runtime, not parse-time.
    model: z.string().min(1).default('claude-haiku-4-5-20251001'),
    features: FeaturesSchema.default({
      verification: false,
      smart_report: false,
      policy_suggestions: false,
      orchestrator_chat: false,
    }),
    budget: BudgetSchema.default({
      monthly_cap_usd: 5,
      alert_threshold_pct: 80,
      reset_day_of_month: 1,
    }),
    credentials: CredentialsSchema.default({}),
  })
  .strict()

export type LlmConfig = z.infer<typeof LlmConfigSchema>

// Defaults match the spec: everything off, anthropic + haiku as the
// "if you turn it on" choice (cheap + fast).
export function defaultLlmConfig(): LlmConfig {
  return LlmConfigSchema.parse({
    credentials: {
      anthropic: { secret_name: 'anthropic-key' },
      openai: { secret_name: 'openai-key' },
      gemini: { secret_name: 'gemini-key' },
      ollama: { endpoint: 'http://localhost:11434', secret_name: null },
      openai_compatible: {
        endpoint_secret: 'openai-compatible-endpoint',
        key_secret: 'openai-compatible-key',
      },
    },
  })
}

// ============================================================================
// Load + save
// ============================================================================

export function loadLlmConfig(path: string): LlmConfig {
  if (!existsSync(path)) return defaultLlmConfig()
  const raw = readFileSync(path, 'utf-8')
  const parsed = raw.trim().length === 0 ? {} : (parseYaml(raw) as unknown)
  // Merge with defaults so missing keys don't crash an older config.
  return LlmConfigSchema.parse(mergeWithDefaults(parsed))
}

export function saveLlmConfig(path: string, config: LlmConfig): void {
  const yaml = stringifyYaml(config, { lineWidth: 120 })
  writeFileSync(path, yaml, 'utf-8')
}

function mergeWithDefaults(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return defaultLlmConfig()
  const defaults = defaultLlmConfig()
  const obj = input as Record<string, unknown>
  return {
    ...defaults,
    ...obj,
    features: {
      ...defaults.features,
      ...((obj.features as Record<string, unknown>) ?? {}),
    },
    budget: {
      ...defaults.budget,
      ...((obj.budget as Record<string, unknown>) ?? {}),
    },
    credentials: {
      ...defaults.credentials,
      ...((obj.credentials as Record<string, unknown>) ?? {}),
    },
  }
}

// ============================================================================
// Feature accessor
// ============================================================================

export type LlmFeature = keyof LlmConfig['features']

/** True only when the GLOBAL switch is on AND the per-feature flag is on. */
export function isFeatureEnabled(
  config: LlmConfig,
  feature: LlmFeature,
): boolean {
  return config.enabled && config.features[feature] === true
}
