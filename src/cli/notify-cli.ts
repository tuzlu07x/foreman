import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { Command } from 'commander'
import { ulid } from 'ulid'
import { NotificationService } from '../core/notification/notification-service.js'
import {
  addChannelToRoutes,
  channelConfig,
  defaultNotifyConfig,
  isChannelEnabled,
  loadNotifyConfig,
  saveNotifyConfig,
  type ChannelToggle,
} from '../core/notification/notify-config.js'
import { buildChannel } from '../core/notification/channel-factory.js'
import {
  defaultNotifyState,
  isAgentMuted,
  isSilenced,
  loadNotifyState,
  parseDuration,
  saveNotifyState,
  type NotifyState,
} from '../core/notification/notify-state.js'
import {
  generateSmartSummaryPayload,
  generateSummary,
} from '../core/notification/summary-generator.js'
import { isFeatureEnabled, loadLlmConfig } from '../core/llm/config.js'
import { buildLlmClient } from '../core/llm/factory.js'
import {
  KNOWN_CHANNELS,
  isKnownChannel,
  type ChannelId,
  type Notification,
  type NotificationChannel,
} from '../core/notification/types.js'
import { SecretStore } from '../core/secret-store.js'
import { closeDb, getDb } from '../db/client.js'
import { loadOrCreateSecretsMasterKey } from '../identity/master-key.js'
import { getForemanPaths } from '../utils/config.js'
import { dim, green, orange, red } from './colors.js'
import { safeLoadConfig } from './safe-load.js'

export const notifyCommand = new Command('notify').description(
  'Out-of-band notification channels (Telegram primary)',
)

notifyCommand
  .command('status')
  .description('Show enabled channels + last 5 notifications')
  .action(() => {
    requireInitialised()
    const paths = getForemanPaths()
    const config = safeLoadConfig(paths.notifyConfigPath, loadNotifyConfig, { label: 'notify.yaml' })

    console.log(orange('channels'))
    const channels = Object.entries(config.channels)
    if (channels.length === 0) {
      console.log(`  ${dim('(no channels configured — `foreman notify enable telegram` to start)')}`)
    } else {
      for (const [id, ch] of channels) {
        if (!ch) continue
        const flag = ch.enabled ? green('●') : dim('○')
        const detail = describeChannel(id, ch)
        console.log(`  ${flag} ${id.padEnd(8)} ${detail}`)
      }
    }

    console.log('')
    console.log(orange('routing'))
    for (const [level, route] of Object.entries(config.routing)) {
      if (!route) continue
      const channelList =
        route.channels.length > 0 ? route.channels.join(', ') : dim('(none)')
      const tag =
        route.timeout_seconds > 0
          ? dim(` · timeout ${route.timeout_seconds}s → ${route.default_action ?? 'deny'}`)
          : ''
      console.log(`  ${level.padEnd(13)} → ${channelList}${tag}`)
    }

    const state = loadNotifyState(paths.notifyStatePath)
    if (isSilenced(state) || state.mutedAgents.length > 0) {
      console.log('')
      console.log(orange('runtime state'))
      if (isSilenced(state)) {
        const until = new Date(state.silencedUntil!).toISOString().slice(0, 19)
        console.log(`  ${orange('silenced')} until ${until} UTC ${dim('(critical alerts still fire)')}`)
      }
      if (state.mutedAgents.length > 0) {
        console.log(`  ${orange('muted agents')}: ${state.mutedAgents.join(', ')}`)
      }
    }

    const db = getDb()
    const service = new NotificationService({ db, config, channels: new Map() })
    const recent = service.recent(5)
    console.log('')
    console.log(orange(`last ${recent.length} notification${recent.length === 1 ? '' : 's'}`))
    if (recent.length === 0) {
      console.log(`  ${dim('(none yet — `foreman notify test telegram` to fire one)')}`)
    } else {
      for (const n of recent) {
        const decision = n.decision
          ? n.decision === 'allow'
            ? green('allowed')
            : red(n.decision)
          : dim(n.status)
        console.log(`  ${dim(formatTime(n.sentAt))} ${n.level.padEnd(13)} ${n.channel.padEnd(8)} ${decision}`)
      }
    }
    closeDb()
  })

notifyCommand
  .command('enable <channel>')
  .description('Enable a channel — channel must already have credentials configured')
  .action((channel: string) => {
    requireInitialised()
    // Reject typo'd channel names BEFORE writing anything (#264) — otherwise
    // the garbage entry ends up in the user's notify.yaml and `status` quietly
    // ignores it, masking the typo.
    if (!isKnownChannel(channel)) {
      console.error(
        red('error: ') +
          `unknown channel "${channel}" — try ${KNOWN_CHANNELS.join(' / ')}`,
      )
      process.exit(1)
    }
    const paths = getForemanPaths()
    const config = existsSync(paths.notifyConfigPath)
      ? safeLoadConfig(paths.notifyConfigPath, loadNotifyConfig, { label: 'notify.yaml' })
      : defaultNotifyConfig()
    const existing = channelConfig(config, channel)
    const next: ChannelToggle = { ...(existing ?? {}), enabled: true }
    setChannel(config, channel, next)
    saveNotifyConfig(paths.notifyConfigPath, config)
    console.log(`${green('✓')} ${channel} enabled in ${dim(paths.notifyConfigPath)}`)
    if (!existing?.bot_token_ref && channel === 'telegram') {
      console.log(
        dim(
          '  → set credentials: `foreman secrets add telegram-bot-token` then edit notify.yaml',
        ),
      )
    }
  })

notifyCommand
  .command('disable <channel>')
  .description('Disable a channel without removing its credentials')
  .action((channel: string) => {
    requireInitialised()
    const paths = getForemanPaths()
    if (!existsSync(paths.notifyConfigPath)) {
      console.error(red('error: ') + 'no notify.yaml — nothing to disable')
      process.exit(1)
    }
    const config = safeLoadConfig(paths.notifyConfigPath, loadNotifyConfig, { label: 'notify.yaml' })
    const existing = channelConfig(config, channel)
    if (!existing) {
      console.error(red('error: ') + `unknown channel: ${channel}`)
      process.exit(1)
    }
    setChannel(config, channel, { ...existing, enabled: false })
    saveNotifyConfig(paths.notifyConfigPath, config)
    console.log(`${green('✓')} ${channel} disabled`)
  })

notifyCommand
  .command('silence <duration>')
  .description(
    'Mute non-critical notifications for a window (e.g. 30m, 4h, 1d). Critical alerts still fire.',
  )
  .action((duration: string) => {
    requireInitialised()
    const paths = getForemanPaths()
    const ms = parseDuration(duration)
    if (ms === null) {
      console.error(
        red('error: ') +
          `unparseable duration: "${duration}" — try 30m, 4h, 1d`,
      )
      process.exit(1)
    }
    const state = loadNotifyState(paths.notifyStatePath)
    state.silencedUntil = Date.now() + ms
    saveNotifyState(paths.notifyStatePath, state)
    const until = new Date(state.silencedUntil).toISOString().slice(0, 19)
    console.log(
      `${green('✓')} non-critical notifications silenced until ${until} UTC`,
    )
  })

notifyCommand
  .command('unsilence')
  .description('Clear the active silence window')
  .action(() => {
    requireInitialised()
    const paths = getForemanPaths()
    const state = loadNotifyState(paths.notifyStatePath)
    if (state.silencedUntil === null || state.silencedUntil <= Date.now()) {
      console.log(dim('(no active silence window)'))
      return
    }
    state.silencedUntil = null
    saveNotifyState(paths.notifyStatePath, state)
    console.log(`${green('✓')} silence cleared — non-critical alerts back on`)
  })

notifyCommand
  .command('mute <agent>')
  .description("Don't alert about any tool call from this source agent")
  .action((agent: string) => {
    requireInitialised()
    const paths = getForemanPaths()
    const state = loadNotifyState(paths.notifyStatePath)
    if (state.mutedAgents.includes(agent)) {
      console.log(dim(`(${agent} is already muted)`))
      return
    }
    state.mutedAgents.push(agent)
    saveNotifyState(paths.notifyStatePath, state)
    console.log(`${green('✓')} ${agent} muted — won't trigger OOB alerts`)
  })

notifyCommand
  .command('unmute <agent>')
  .description('Re-enable alerts for a previously muted source agent')
  .action((agent: string) => {
    requireInitialised()
    const paths = getForemanPaths()
    const state = loadNotifyState(paths.notifyStatePath)
    if (!state.mutedAgents.includes(agent)) {
      console.log(dim(`(${agent} was not muted)`))
      return
    }
    state.mutedAgents = state.mutedAgents.filter((a) => a !== agent)
    saveNotifyState(paths.notifyStatePath, state)
    console.log(`${green('✓')} ${agent} unmuted — alerts back on`)
  })

notifyCommand
  .command('summary')
  .description('Build a digest of recent activity and (optionally) send it now')
  .option('--now', 'Send the digest immediately on every enabled channel', false)
  .option('--hours <n>', 'Window in hours (1-8760, default 12)', (v) => parseInt(v, 10), 12)
  .option(
    '--smart',
    'Run the LLM narrator if enabled (otherwise template body — #306)',
    false,
  )
  .action(async (options: { now?: boolean; hours: number; smart?: boolean }) => {
    requireInitialised()
    // Reject garbage hours BEFORE generating anything (#266). Commander's
    // parseInt happily turns "notanumber" into NaN and lets it through; we
    // also want to refuse 0 / negative / absurdly large windows so the digest
    // header doesn't read "last NaN minutes" / "last 4167 days".
    if (
      !Number.isFinite(options.hours) ||
      !Number.isInteger(options.hours) ||
      options.hours < 1 ||
      options.hours > 8760
    ) {
      console.error(
        red('error: ') +
          `--hours must be an integer between 1 and 8760 (got: ${options.hours})`,
      )
      process.exit(1)
    }
    const paths = getForemanPaths()
    const db = getDb()
    let llmClient: import('../core/llm/client.js').LlmClient | null = null
    if (options.smart) {
      // #306 — build the LLM client only when --smart is asked for so the
      // CLI stays cheap when the user just wants the template body.
      try {
        const cfg = loadLlmConfig(paths.llmConfigPath)
        if (isFeatureEnabled(cfg, 'smart_report')) {
          const store = new SecretStore(db, loadOrCreateSecretsMasterKey())
          llmClient = buildLlmClient(cfg, store)
        }
      } catch {
        // Silently fall back to template — the body will say so via the
        // generateSummary footer.
      }
    }
    const payload = await generateSmartSummaryPayload(db, {
      windowMs: options.hours * 3_600_000,
      llmClient,
    })

    if (!options.now) {
      console.log(payload.title)
      console.log('')
      console.log(payload.body)
      closeDb()
      return
    }

    const config = safeLoadConfig(paths.notifyConfigPath, loadNotifyConfig, { label: 'notify.yaml' })
    const channelIds = config.routing.summary?.channels ?? []
    if (channelIds.length === 0) {
      console.error(
        red('error: ') +
          'routing.summary has no channels — edit notify.yaml first',
      )
      closeDb()
      process.exit(1)
    }

    let sent = 0
    for (const channelId of channelIds) {
      const ch = await buildChannelForCli(channelId, config)
      if (!ch) continue
      try {
        await ch.send({ id: `summary-${Date.now()}`, ...payload })
        console.log(`${green('✓')} summary sent via ${channelId}`)
        sent += 1
      } catch (err) {
        console.error(
          red('error: ') +
            `${channelId} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      } finally {
        try {
          await ch.shutdown()
        } catch {
          /* ignore */
        }
      }
    }
    if (sent === 0) {
      console.error(red('error: ') + 'no channels delivered the summary')
      closeDb()
      process.exit(1)
    }
    closeDb()
  })

notifyCommand
  .command('test <channel>')
  .description('Send a test notification to verify channel credentials')
  .action(async (channel: string) => {
    requireInitialised()
    // Reject typo'd channel names BEFORE looking at config so the error
    // points at the real cause (#264) — old message told users to "enable
    // bogus first", which is a dead-end loop.
    if (!isKnownChannel(channel)) {
      console.error(
        red('error: ') +
          `unknown channel "${channel}" — try ${KNOWN_CHANNELS.join(' / ')}`,
      )
      process.exit(1)
    }
    const paths = getForemanPaths()
    const config = safeLoadConfig(paths.notifyConfigPath, loadNotifyConfig, { label: 'notify.yaml' })
    if (!isChannelEnabled(config, channel)) {
      console.error(
        red('error: ') +
          `${channel} is not enabled — run \`foreman notify enable ${channel}\` first`,
      )
      process.exit(1)
    }
    const ch = await buildChannelForCli(channel, config)
    if (!ch) process.exit(1)

    const test: Notification = {
      id: 'test-' + Date.now(),
      level: 'info',
      requestId: null,
      title: 'Foreman test ✓',
      body: `Sent by \`foreman notify test ${channel}\` at ${new Date().toISOString()}`,
      actions: [],
      agentBlocking: false,
    }
    // Bypass routing — the test command should hit the channel the user
    // picked regardless of notify.yaml routing (which may not list the
    // test channel for the chosen level).
    try {
      const ref = await ch.send(test)
      console.log(
        `${green('✓')} test message sent (message_id=${ref.channelMessageId})`,
      )
    } catch (err) {
      console.error(
        red('error: ') +
          `delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      process.exit(1)
    } finally {
      try {
        await ch.shutdown()
      } catch {
        /* ignore */
      }
      closeDb()
    }
  })

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

function describeChannel(id: string, ch: ChannelToggle): string {
  // System channel needs no credentials — flag it specially so the user
  // doesn't see a confusing "credentials missing" status for it.
  if (id === 'system') return dim('(no credentials required)')
  const bits: string[] = []
  if (ch.bot_token_ref) bits.push(`token=${ch.bot_token_ref}`)
  if (ch.chat_id) bits.push(`chat=${ch.chat_id}`)
  if (ch.webhook_url_ref) bits.push(`url=${ch.webhook_url_ref}`)
  if (ch.signing_secret_ref) bits.push(`sig=${ch.signing_secret_ref}`)
  if (ch.channel) bits.push(`#${ch.channel}`)
  if (ch.smtp_host) bits.push(`smtp=${ch.smtp_host}${ch.smtp_port ? `:${ch.smtp_port}` : ''}`)
  if (ch.email_to?.length) bits.push(`to=${ch.email_to.join(',')}`)
  if (ch.topic_ref) bits.push(`topic=${ch.topic_ref}${ch.server ? ` @ ${ch.server}` : ''}`)
  return bits.length > 0 ? dim(bits.join(' · ')) : dim('(credentials missing)')
}

function setChannel(
  config: Awaited<ReturnType<typeof loadNotifyConfig>>,
  id: string,
  next: ChannelToggle,
): void {
  const all = config.channels as Record<string, ChannelToggle | undefined>
  all[id] = next
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

async function buildChannelForCli(
  channelId: string,
  config: Awaited<ReturnType<typeof loadNotifyConfig>>,
): Promise<NotificationChannel | null> {
  if (!isKnownChannel(channelId)) return null
  const toggle = channelConfig(config, channelId) ?? { enabled: true }
  const store = new SecretStore(getDb(), loadOrCreateSecretsMasterKey())
  const built = buildChannel(channelId, toggle, { secrets: store })
  if ('problem' in built) {
    console.error(red('error: ') + built.problem)
    return null
  }
  return built.channel
}

notifyCommand
  .command('route <level> [channels...]')
  .description(
    'Choose which channels receive a level (critical, warning, info, summary, budget_alert, risk_deny, activity_summary, session_lifecycle). No channels = mute that level.',
  )
  .action((level: string, channels: string[]) => {
    requireInitialised()
    if (!ROUTE_LEVELS.includes(level as (typeof ROUTE_LEVELS)[number])) {
      console.error(red('error: ') + `unknown level "${level}" — try ${ROUTE_LEVELS.join(' / ')}`)
      process.exit(1)
    }
    for (const c of channels) {
      if (!isKnownChannel(c)) {
        console.error(red('error: ') + `unknown channel "${c}" — try ${KNOWN_CHANNELS.join(' / ')}`)
        process.exit(1)
      }
    }
    const paths = getForemanPaths()
    const config = existsSync(paths.notifyConfigPath)
      ? safeLoadConfig(paths.notifyConfigPath, loadNotifyConfig, { label: 'notify.yaml' })
      : defaultNotifyConfig()
    const routing = config.routing as Record<string, { channels: string[]; timeout_seconds: number; default_action: 'allow' | 'deny'; schedule?: string } | undefined>
    const current = routing[level] ?? { channels: [], timeout_seconds: 0, default_action: 'deny' as const }
    routing[level] = { ...current, channels: [...new Set(channels)] }
    saveNotifyConfig(paths.notifyConfigPath, config)
    console.log(`${green('✓')} ${level} → ${channels.length > 0 ? channels.join(', ') : dim('(muted)')}`)
  })

notifyCommand
  .command('ntfy-setup')
  .description('Phone push in one step: create a private ntfy topic, store it, enable + route it')
  .option('--server <url>', 'ntfy server (self-hosted recommended for sensitive setups)', 'https://ntfy.sh')
  .action((opts: { server: string }) => {
    requireInitialised()
    const paths = getForemanPaths()
    const store = new SecretStore(getDb(), loadOrCreateSecretsMasterKey())
    // The topic name is the only secret on a public ntfy server: make it
    // unguessable and keep it in the encrypted store.
    const topic = `foreman-${randomBytes(15).toString('base64url')}`
    if (store.exists(NTFY_TOPIC_SECRET)) store.rotate(NTFY_TOPIC_SECRET, topic)
    else store.add(NTFY_TOPIC_SECRET, topic)
    const config = existsSync(paths.notifyConfigPath)
      ? safeLoadConfig(paths.notifyConfigPath, loadNotifyConfig, { label: 'notify.yaml' })
      : defaultNotifyConfig()
    setChannel(config, 'ntfy', {
      ...(channelConfig(config, 'ntfy') ?? {}),
      enabled: true,
      server: opts.server,
      topic_ref: NTFY_TOPIC_SECRET,
    })
    addChannelToRoutes(config, 'ntfy', ['critical', 'warning', 'risk_deny', 'budget_alert', 'summary'])
    saveNotifyConfig(paths.notifyConfigPath, config)
    closeDb()
    console.log(`${green('✓')} ntfy enabled — critical, warning, blocked-call, budget and summary alerts go to your phone`)
    console.log('')
    console.log(`  1. Install the ntfy app (iOS / Android / desktop): https://ntfy.sh`)
    console.log(`  2. Subscribe to this topic${opts.server === 'https://ntfy.sh' ? '' : ` on ${opts.server}`}:`)
    console.log(`       ${orange(topic)}`)
    console.log(`  3. Check it: foreman notify test ntfy`)
    console.log('')
    console.log(dim('  Keep the topic private — anyone who knows it can read your alerts. Rotate: re-run this command.'))
  })

const NTFY_TOPIC_SECRET = 'ntfy-topic'

// #610 — A second Telegram bot that only Foreman holds and polls. Approval
// prompts go through it, so the chat agent sharing the main bot never sees
// an approval button.
notifyCommand
  .command('approval-bot')
  .description('Route Telegram approvals through a bot only Foreman uses (recommended)')
  .option('--token-ref <name>', 'secret holding the approval bot token', 'telegram-approval-bot-token')
  .option('--no-verify', 'skip checking the token with Telegram')
  .option('--off', 'go back to relaying approvals through the chat bot')
  .action(async (opts: { tokenRef: string; verify: boolean; off?: boolean }) => {
    requireInitialised()
    const paths = getForemanPaths()
    const config = existsSync(paths.notifyConfigPath)
      ? safeLoadConfig(paths.notifyConfigPath, loadNotifyConfig, { label: 'notify.yaml' })
      : defaultNotifyConfig()
    const telegram = channelConfig(config, 'telegram')
    if (opts.off) {
      if (telegram) {
        const { approval_bot_token_ref: _dropped, ...rest } = telegram
        setChannel(config, 'telegram', rest)
        saveNotifyConfig(paths.notifyConfigPath, config)
      }
      console.log(`${green('✓')} approvals are relayed through the chat bot again`)
      return
    }
    if (!telegram?.bot_token_ref || !telegram.chat_id) {
      fail('set up Telegram first: foreman notify enable telegram (bot token + chat id)')
    }
    const store = new SecretStore(getDb(), loadOrCreateSecretsMasterKey())
    let username: string | null = null
    try {
      if (!store.exists(opts.tokenRef)) {
        fail(
          `no secret '${opts.tokenRef}'. Create a second bot with @BotFather, then: foreman secrets add ${opts.tokenRef}`,
        )
      }
      const token = store.get(opts.tokenRef)
      if (store.exists(telegram.bot_token_ref) && store.get(telegram.bot_token_ref) === token) {
        fail('the approval bot must be a different bot from the chat bot (its token is shared with your agent)')
      }
      if (opts.verify) {
        const res = await fetch(`https://api.telegram.org/bot${token}/getMe`).catch(() => null)
        const body = (await res?.json().catch(() => null)) as { ok?: boolean; result?: { username?: string } } | null
        if (!body?.ok) fail('Telegram rejected that token (re-run with --no-verify to skip this check)')
        username = body.result?.username ?? null
      }
      setChannel(config, 'telegram', { ...telegram, approval_bot_token_ref: opts.tokenRef })
      saveNotifyConfig(paths.notifyConfigPath, config)
    } finally {
      closeDb()
    }
    console.log(`${green('✓')} Telegram approvals now go through ${username ? orange(`@${username}`) : 'the approval bot'}`)
    console.log('')
    console.log(`  1. Open a chat with ${username ? `@${username}` : 'the bot'} and press Start (Telegram requires it once).`)
    console.log('  2. Restart foreman start. It polls the approval bot itself.')
    console.log(dim('  Never give this token to an agent. Undo: foreman notify approval-bot --off'))
  })

function fail(message: string): never {
  console.error(`${red('error:')} ${message}`)
  closeDb()
  process.exit(1)
}

const ROUTE_LEVELS = [
  'critical',
  'warning',
  'info',
  'summary',
  'budget_alert',
  'risk_deny',
  'activity_summary',
  'session_lifecycle',
] as const

void ulid // re-export reservation for future cli verbs (silence, mute …)
