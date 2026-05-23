import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { Command } from 'commander'
import {
  defaultLlmConfig,
  isFeatureEnabled,
  loadLlmConfig,
  saveLlmConfig,
  setAuthMode,
  type LlmConfig,
  type LlmFeature,
} from '../core/llm/config.js'

// Re-exported so existing importers (`tests/cli/llm-login.test.ts`,
// `foreman llm logout` / `login` callers) keep working after setAuthMode
// moved into `core/llm/config.ts` to be shared with the chat-side login
// handler in #514's follow-up.
export { setAuthMode }
import {
  buildLlmClient,
  LlmCredentialMissingError,
  LlmProviderUnavailableError,
} from '../core/llm/factory.js'
import {
  featureSplit,
  getBudgetStatus,
  parseSince,
  queryUsage,
  recordUsage,
} from '../core/llm/budget.js'
import {
  runLoginFlow,
  type OAuthTokens,
} from '../core/llm/oauth/oauth-flow.js'
import {
  getOAuthProvider,
  isOAuthProviderId,
  type OAuthProviderConfig,
  type OAuthProviderId,
} from '../core/llm/oauth/oauth-providers.js'
import {
  clearOAuthTokens,
  loadOAuthTokens,
  saveOAuthTokens,
} from '../core/llm/oauth/token-store.js'
import { SecretStore } from '../core/secret-store.js'
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
    console.log(`  Auth:`)
    const store = new SecretStore(db, loadOrCreateSecretsMasterKey())
    for (const pid of ['anthropic', 'openai'] as const) {
      console.log(
        `    ${pid.padEnd(20)} ${describeAuthMode(config, store, pid)}`,
      )
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
    const db = getDb()
    let client
    try {
      const store = new SecretStore(db, loadOrCreateSecretsMasterKey())
      client = buildLlmClient(config, store)
    } catch (err) {
      if (err instanceof LlmProviderUnavailableError) {
        console.error(red('error: ') + err.message)
        closeDb()
        process.exit(2)
      }
      if (err instanceof LlmCredentialMissingError) {
        console.error(red('error: ') + err.message)
        closeDb()
        process.exit(1)
      }
      throw err
    }
    try {
      const res = await client.ping()
      recordUsage(db, {
        provider: config.provider,
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
// login / logout — subscription OAuth (Claude + Codex)
// ============================================================================

llmCommand
  .command('login <provider>')
  .description(
    'Sign in to a provider with your subscription (anthropic | openai)',
  )
  .option(
    '--headless',
    'Skip the loopback callback server; instead show the URL and prompt for ' +
      'the redirect URL/code you paste back. Use on SSH / remote shells where ' +
      "the browser can't reach the Foreman host's localhost.",
    false,
  )
  .action(async (providerArg: string, opts: { headless: boolean }) => {
    requireInitialised()
    if (!isOAuthProviderId(providerArg)) {
      console.error(
        red('error: ') +
          `Unknown OAuth provider '${providerArg}'. Use: anthropic | openai`,
      )
      process.exit(2)
    }
    const provider = getOAuthProvider(providerArg)
    const paths = getForemanPaths()
    const db = getDb()
    try {
      const store = new SecretStore(db, loadOrCreateSecretsMasterKey())
      console.log(orange(`Foreman — sign in to ${provider.label}`))
      console.log('')
      const result = await performOAuthLogin(
        provider,
        { headless: opts.headless },
        { llmConfigPath: paths.llmConfigPath },
        store,
        defaultLoginDeps(),
      )
      console.log('')
      console.log(green('✓ Signed in successfully'))
      if (result.accountId) {
        console.log(`  ${dim('account')}    ${result.accountId}`)
      }
      console.log(
        `  ${dim('auth_mode')}  credentials.${provider.id} → oauth (saved to llm.yaml)`,
      )
    } catch (err) {
      console.error(
        red('error: ') +
          `Login failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      process.exit(1)
    } finally {
      closeDb()
    }
  })

llmCommand
  .command('logout <provider>')
  .description(
    'Forget an OAuth login and revert that provider to API-key auth_mode',
  )
  .action((providerArg: string) => {
    requireInitialised()
    if (!isOAuthProviderId(providerArg)) {
      console.error(
        red('error: ') +
          `Unknown OAuth provider '${providerArg}'. Use: anthropic | openai`,
      )
      process.exit(2)
    }
    const paths = getForemanPaths()
    const db = getDb()
    try {
      const store = new SecretStore(db, loadOrCreateSecretsMasterKey())
      const hadTokens = loadOAuthTokens(store, providerArg) !== null
      performOAuthLogout(
        providerArg,
        { llmConfigPath: paths.llmConfigPath },
        store,
      )
      console.log(
        hadTokens
          ? `${green('✓')} Signed out (${providerArg}: tokens cleared, auth_mode → api_key)`
          : `${dim('○')} ${providerArg} was already signed out (auth_mode → api_key)`,
      )
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

// ============================================================================
// OAuth login / logout — testable cores
// ============================================================================
//
// The commander actions above are thin wrappers; the actual work lives here so
// it can be unit-tested with mocked deps (runLogin, openInBrowser, prompt).

/** Side-effecting collaborators the login flow needs. Injecting them lets
 *  tests replace the network + IO with deterministic mocks. */
export interface LoginDeps {
  /** Runs the PKCE flow against the real OAuth servers. Replace in tests. */
  runLogin: typeof runLoginFlow
  /** Opens (or prints) the authorize URL. */
  openInBrowser: (url: string) => void
  /** Prompts the user to paste the redirect URL / code (headless mode). */
  promptPaste: () => Promise<string>
}

/** Default deps used by the CLI — real fetch, real spawn, real readline. */
export function defaultLoginDeps(): LoginDeps {
  return {
    runLogin: runLoginFlow,
    openInBrowser,
    promptPaste: promptForCallback,
  }
}

/** Perform a full OAuth login: run the PKCE flow, persist the resulting
 *  tokens, flip `auth_mode: oauth` on the provider's credential block in
 *  `llm.yaml`. Returns the account id (Codex only) for the caller to surface. */
export async function performOAuthLogin(
  provider: OAuthProviderConfig,
  opts: { headless: boolean },
  paths: { llmConfigPath: string },
  store: SecretStore,
  deps: LoginDeps,
): Promise<{ accountId?: string }> {
  const tokens: OAuthTokens = await deps.runLogin(provider, {
    presentAuthUrl: deps.openInBrowser,
    useLoopback: !opts.headless,
    ...(opts.headless ? { readPastedCode: deps.promptPaste } : {}),
  })
  saveOAuthTokens(store, provider.id, tokens)
  const config = loadLlmConfig(paths.llmConfigPath)
  saveLlmConfig(paths.llmConfigPath, setAuthMode(config, provider.id, 'oauth'))
  return tokens.accountId ? { accountId: tokens.accountId } : {}
}

/** Forget a provider's OAuth tokens and revert its `auth_mode` to `api_key`. */
export function performOAuthLogout(
  providerId: OAuthProviderId,
  paths: { llmConfigPath: string },
  store: SecretStore,
): void {
  clearOAuthTokens(store, providerId)
  const config = loadLlmConfig(paths.llmConfigPath)
  saveLlmConfig(
    paths.llmConfigPath,
    setAuthMode(config, providerId, 'api_key'),
  )
}

/** One-line description of a provider's authentication state, for `status`. */
export function describeAuthMode(
  config: LlmConfig,
  store: SecretStore,
  providerId: OAuthProviderId,
): string {
  const cred = config.credentials[providerId]
  if (cred?.auth_mode === 'oauth') {
    const tokens = loadOAuthTokens(store, providerId)
    if (!tokens) {
      return `${orange('OAuth (not signed in)')} — run \`foreman llm login ${providerId}\``
    }
    const account = tokens.accountId ? `, account ${tokens.accountId}` : ''
    return `${green('OAuth')} (signed in${account})`
  }
  return cred?.secret_name
    ? `${dim('api key')} (${cred.secret_name})`
    : `${dim('api key')} (no secret_name)`
}

/** Best-effort browser open with a printed URL fallback. The URL prints in
 *  every case so a failed open still leaves the user something to click. */
function openInBrowser(url: string): void {
  console.log('Open this URL in your browser to sign in:')
  console.log('')
  console.log(`  ${url}`)
  console.log('')
  const platform = process.platform
  const cmd =
    platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
  } catch {
    // Fall through — the URL is already on screen.
  }
}

/** Prompt the user to paste the redirect URL / code from the browser. Used in
 *  --headless mode where the loopback server can't catch the callback. */
async function promptForCallback(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(
      "\nAfter signing in, your browser will land on a localhost URL that " +
        "won't load.\nCopy the FULL URL from the address bar and paste it " +
        'here:\n> ',
      (answer) => {
        rl.close()
        resolve(answer)
      },
    )
  })
}

