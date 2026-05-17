import { existsSync } from 'node:fs'
import { Command } from 'commander'
import { LlmProviderError } from '../core/llm/client.js'
import {
  defaultLlmConfig,
  isFeatureEnabled,
  loadLlmConfig,
  saveLlmConfig,
  type LlmConfig,
  type LlmFeature,
} from '../core/llm/config.js'
import { AnthropicLlmClient } from '../core/llm/providers/anthropic.js'
import {
  featureSplit,
  getBudgetStatus,
  parseSince,
  queryUsage,
  recordUsage,
} from '../core/llm/budget.js'
import { SecretNotFoundError, SecretStore } from '../core/secret-store.js'
import { closeDb, getDb } from '../db/client.js'
import { loadOrCreateSecretsMasterKey } from '../identity/master-key.js'
import { getForemanPaths } from '../utils/config.js'
import { dim, green, orange, red } from './colors.js'
import { safeLoadConfig } from './safe-load.js'

export const llmCommand = new Command('llm').description(
  'Optional LLM-backed verification + smart-report features (opt-in)',
)

// ============================================================================
// status
// ============================================================================

llmCommand
  .command('status')
  .description('Show current LLM config, budget, and per-feature flags')
  .action(() => {
    requireInitialised()
    const paths = getForemanPaths()
    const config = safeLoadConfig(paths.llmConfigPath, loadLlmConfig, { label: 'llm.yaml' })
    const db = getDb()
    const budget = getBudgetStatus(db, config)

    console.log(orange('Foreman LLM features'))
    console.log('')
    const globalState = config.enabled ? green('✓ enabled') : dim('○ disabled')
    console.log(`  global              ${globalState}`)
    console.log(
      `  provider            ${config.provider} (${dim(config.model)})`,
    )

    const daysUntilReset = Math.max(
      0,
      Math.ceil((budget.windowEnd - Date.now()) / 86_400_000),
    )
    console.log(
      `  budget              \$${budget.spentUsd.toFixed(2)} / \$${budget.capUsd.toFixed(2)} (${budget.spentPct.toFixed(0)}%) — resets in ${daysUntilReset} day${daysUntilReset === 1 ? '' : 's'}`,
    )
    if (budget.alertTripped && budget.spentUsd < budget.capUsd) {
      console.log(
        `  ${orange('!')} budget alert tripped — ${budget.spentPct.toFixed(0)}% of cap used`,
      )
    }
    if (budget.spentUsd >= budget.capUsd) {
      console.log(`  ${red('✗')} budget exceeded — LLM features will refuse calls`)
    }

    console.log('')
    console.log(`  Features:`)
    for (const feature of ['verification', 'smart_report', 'policy_suggestions'] as const) {
      const flag = config.features[feature]
        ? green('✓ on')
        : dim('off')
      const effectively = isFeatureEnabled(config, feature)
      const note =
        config.features[feature] && !effectively
          ? dim(' (overridden — global off)')
          : ''
      console.log(`    ${feature.padEnd(20)} ${flag}${note}`)
    }
    closeDb()
  })

// ============================================================================
// enable / disable
// ============================================================================

llmCommand
  .command('enable [feature]')
  .description(
    'Turn on the global switch (no arg), or enable a specific feature (verification / smart_report / policy_suggestions)',
  )
  .action((feature: string | undefined) => {
    requireInitialised()
    const paths = getForemanPaths()
    const config = existsSync(paths.llmConfigPath)
      ? safeLoadConfig(paths.llmConfigPath, loadLlmConfig, { label: 'llm.yaml' })
      : defaultLlmConfig()
    if (!feature) {
      config.enabled = true
      saveLlmConfig(paths.llmConfigPath, config)
      console.log(`${green('✓')} LLM global switch enabled`)
      if (!hasAnyFeatureOn(config)) {
        console.log(
          dim(
            '  → no individual features are on yet — try `foreman llm enable verification`',
          ),
        )
      }
      return
    }
    if (!isKnownFeature(feature)) {
      console.error(
        red('error: ') +
          `unknown feature: ${feature} — try verification / smart_report / policy_suggestions`,
      )
      process.exit(1)
    }
    config.features[feature] = true
    saveLlmConfig(paths.llmConfigPath, config)
    console.log(`${green('✓')} ${feature} enabled`)
    if (!config.enabled) {
      console.log(
        dim(
          '  → global switch is still OFF — `foreman llm enable` (no arg) to turn it on',
        ),
      )
    }
  })

llmCommand
  .command('disable [feature]')
  .description('Turn off the global switch (no arg), or disable a specific feature')
  .action((feature: string | undefined) => {
    requireInitialised()
    const paths = getForemanPaths()
    if (!existsSync(paths.llmConfigPath)) {
      console.log(dim('(no llm.yaml — already disabled)'))
      return
    }
    const config = safeLoadConfig(paths.llmConfigPath, loadLlmConfig, { label: 'llm.yaml' })
    if (!feature) {
      config.enabled = false
      saveLlmConfig(paths.llmConfigPath, config)
      console.log(`${green('✓')} LLM global switch disabled`)
      return
    }
    if (!isKnownFeature(feature)) {
      console.error(red('error: ') + `unknown feature: ${feature}`)
      process.exit(1)
    }
    config.features[feature] = false
    saveLlmConfig(paths.llmConfigPath, config)
    console.log(`${green('✓')} ${feature} disabled`)
  })

// ============================================================================
// test — one-shot ping the configured provider
// ============================================================================

llmCommand
  .command('test')
  .description('Send a test prompt to the configured provider (uses cheapest call)')
  .action(async () => {
    requireInitialised()
    const paths = getForemanPaths()
    const config = safeLoadConfig(paths.llmConfigPath, loadLlmConfig, { label: 'llm.yaml' })
    if (config.provider !== 'anthropic') {
      console.error(
        red('error: ') +
          `${config.provider} provider ships in C7-2 (#230) — only anthropic is implemented in this PR`,
      )
      process.exit(2)
    }
    const db = getDb()
    const client = await buildAnthropicClient(config)
    if (!client) {
      closeDb()
      process.exit(1)
    }
    try {
      const res = await client.ping()
      recordUsage(db, {
        provider: 'anthropic',
        model: client.model,
        feature: 'test',
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        costUsd: res.costUsd,
        durationMs: res.durationMs,
      })
      console.log(`${green('✓')} ${config.provider} responded in ${res.durationMs}ms`)
      console.log(`  ${dim('reply')}      ${res.text.trim().slice(0, 80)}`)
      console.log(
        `  ${dim('tokens')}     in=${res.inputTokens} out=${res.outputTokens}`,
      )
      console.log(`  ${dim('cost')}       \$${res.costUsd.toFixed(6)}`)
    } catch (err) {
      console.error(
        red('error: ') +
          `LLM test failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      process.exit(1)
    } finally {
      closeDb()
    }
  })

// ============================================================================
// budget — set + status
// ============================================================================

llmCommand
  .command('budget')
  .description('View or change the monthly LLM budget')
  .option('--set <usd>', 'Set the monthly cap in USD', (v) => Number(v))
  .option('--alert <pct>', 'Set the % at which to fire a budget alert', (v) => parseInt(v, 10))
  .option('--reset-day <n>', 'Day of month the budget resets (1-28)', (v) => parseInt(v, 10))
  .option('--status', 'Print detailed budget status (default if no other option)', false)
  .action((options: { set?: number; alert?: number; resetDay?: number; status?: boolean }) => {
    requireInitialised()
    const paths = getForemanPaths()
    const config = existsSync(paths.llmConfigPath)
      ? safeLoadConfig(paths.llmConfigPath, loadLlmConfig, { label: 'llm.yaml' })
      : defaultLlmConfig()

    let changed = false
    if (options.set !== undefined) {
      if (!Number.isFinite(options.set) || options.set <= 0) {
        console.error(red('error: ') + `--set must be a positive USD amount`)
        process.exit(1)
      }
      config.budget.monthly_cap_usd = options.set
      changed = true
    }
    if (options.alert !== undefined) {
      if (!Number.isInteger(options.alert) || options.alert < 0 || options.alert > 100) {
        console.error(red('error: ') + `--alert must be an integer 0-100`)
        process.exit(1)
      }
      config.budget.alert_threshold_pct = options.alert
      changed = true
    }
    if (options.resetDay !== undefined) {
      if (
        !Number.isInteger(options.resetDay) ||
        options.resetDay < 1 ||
        options.resetDay > 28
      ) {
        console.error(red('error: ') + `--reset-day must be 1-28`)
        process.exit(1)
      }
      config.budget.reset_day_of_month = options.resetDay
      changed = true
    }

    if (changed) {
      saveLlmConfig(paths.llmConfigPath, config)
      console.log(`${green('✓')} budget config saved`)
    }

    const db = getDb()
    const status = getBudgetStatus(db, config)
    const split = featureSplit(db, config)
    const monthLabel = new Date(status.windowStart).toLocaleString('en-US', {
      month: 'long',
      year: 'numeric',
    })
    console.log('')
    console.log(orange(`Budget — ${monthLabel}`))
    console.log('')
    console.log(`  cap            \$${status.capUsd.toFixed(2)}`)
    const exhausted = status.spentUsd >= status.capUsd
    const tripped =
      status.alertTripped && !exhausted ? orange(' ⚠') : ''
    const exhaustedTag = exhausted ? red(' ✗ exhausted') : ''
    console.log(
      `  spent          \$${status.spentUsd.toFixed(4)}  (${status.spentPct.toFixed(0)}%)${tripped}${exhaustedTag}`,
    )
    console.log(`  remaining      \$${status.remainingUsd.toFixed(4)}`)
    const daysUntilReset = Math.max(
      0,
      Math.ceil((status.windowEnd - Date.now()) / 86_400_000),
    )
    const endLabel = new Date(status.windowEnd).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    })
    console.log(
      `  resets         in ${daysUntilReset} day${daysUntilReset === 1 ? '' : 's'}  (${endLabel})`,
    )
    console.log(
      `  alert at       \$${((config.budget.alert_threshold_pct / 100) * status.capUsd).toFixed(2)} (${config.budget.alert_threshold_pct}%)`,
    )
    if (split.length > 0) {
      const splitLine = split
        .map((s) => `${s.feature} \$${s.spentUsd.toFixed(2)}`)
        .join(' · ')
      console.log(`  feature split  ${splitLine}`)
    }
    console.log('')
    console.log(`  ${renderBar(status.spentPct)}`)
    closeDb()
  })

// ============================================================================
// usage — recent calls
// ============================================================================

llmCommand
  .command('usage')
  .description('Itemise recent LLM calls (cost + feature + tokens)')
  .option('--limit <n>', 'How many rows to show', (v) => parseInt(v, 10), 30)
  .option('--since <Nd|Nh|Nm>', 'Only rows newer than this window (e.g. 24h, 7d)')
  .option('--feature <name>', 'Filter to a single feature (verification / smart_report / test)')
  .option('--json', 'Output JSON instead of a table', false)
  .action(
    (options: {
      limit: number
      since?: string
      feature?: string
      json?: boolean
    }) => {
      requireInitialised()
      const db = getDb()
      let sinceTs: number | undefined
      if (options.since) {
        try {
          sinceTs = Date.now() - parseSince(options.since)
        } catch (err) {
          console.error(
            red('error: ') +
              (err instanceof Error ? err.message : String(err)),
          )
          closeDb()
          process.exit(1)
        }
      }
      const rows = queryUsage(db, {
        limit: options.limit,
        since: sinceTs,
        feature: options.feature,
      })
      if (options.json) {
        process.stdout.write(JSON.stringify(rows, null, 2) + '\n')
        closeDb()
        return
      }
      if (rows.length === 0) {
        console.log(dim('(no matching LLM calls)'))
        closeDb()
        return
      }
      for (const r of rows) {
        const ts = new Date(r.ts).toISOString().slice(0, 19).replace('T', ' ')
        const cost = r.costUsd.toFixed(6)
        const req = r.requestId
          ? dim(` ${r.requestId.slice(0, 5)}…`)
          : ''
        console.log(
          `${dim(ts)} ${r.provider.padEnd(9)} ${r.feature.padEnd(18)} ${r.model.padEnd(22)} in=${String(r.inputTokens).padStart(5)} out=${String(r.outputTokens).padStart(5)} \$${cost} ${dim(`${r.durationMs}ms`)}${r.cacheHit ? dim(' (cache)') : ''}${req}`,
        )
      }
      const total = rows.reduce((s, r) => s + r.costUsd, 0)
      const cached = rows.filter((r) => r.cacheHit).length
      const label = options.since ? `${options.since} total` : `${rows.length}-row total`
      console.log(
        dim(
          `\n${label}: \$${total.toFixed(4)} across ${rows.length} call${rows.length === 1 ? '' : 's'} (${cached} cached)`,
        ),
      )
      closeDb()
    },
  )

// ============================================================================
// Helpers
// ============================================================================

function requireInitialised(): void {
  const paths = getForemanPaths()
  if (!existsSync(paths.root)) {
    console.error(
      red('error: ') +
        `Foreman is not initialised at ${paths.root}. Run 'foreman init' first.`,
    )
    process.exit(1)
  }
}

const KNOWN_FEATURES = new Set(['verification', 'smart_report', 'policy_suggestions'])
function isKnownFeature(s: string): s is LlmFeature {
  return KNOWN_FEATURES.has(s)
}

function hasAnyFeatureOn(config: LlmConfig): boolean {
  return Object.values(config.features).some((v) => v === true)
}

function renderBar(pct: number, width = 30): string {
  const clamped = Math.max(0, Math.min(100, pct))
  const filled = Math.round((clamped / 100) * width)
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  const colour = clamped >= 100 ? red : clamped >= 80 ? orange : green
  return colour(bar)
}

async function buildAnthropicClient(
  config: LlmConfig,
): Promise<AnthropicLlmClient | null> {
  const cred = config.credentials.anthropic
  if (!cred?.secret_name) {
    console.error(
      red('error: ') +
        'anthropic credential.secret_name is unset in llm.yaml',
    )
    return null
  }
  const db = getDb()
  const store = new SecretStore(db, loadOrCreateSecretsMasterKey())
  let apiKey: string
  try {
    apiKey = store.get(cred.secret_name)
  } catch (err) {
    if (err instanceof SecretNotFoundError) {
      console.error(
        red('error: ') +
          `secret '${cred.secret_name}' not found — \`foreman secrets add ${cred.secret_name}\``,
      )
      return null
    }
    throw err
  }
  try {
    return new AnthropicLlmClient({ apiKey, model: config.model })
  } catch (err) {
    if (err instanceof LlmProviderError) {
      console.error(red('error: ') + err.message)
      return null
    }
    throw err
  }
}
