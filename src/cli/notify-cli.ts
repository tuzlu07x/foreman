import { existsSync } from 'node:fs'
import { Command } from 'commander'
import { ulid } from 'ulid'
import { NotificationService } from '../core/notification/notification-service.js'
import {
  channelConfig,
  defaultNotifyConfig,
  isChannelEnabled,
  loadNotifyConfig,
  saveNotifyConfig,
  type ChannelToggle,
} from '../core/notification/notify-config.js'
import { SystemNotifyChannel } from '../core/notification/channels/system.js'
import { TelegramChannel } from '../core/notification/channels/telegram.js'
import { WebhookChannel } from '../core/notification/channels/webhook.js'
import {
  defaultNotifyState,
  isAgentMuted,
  isSilenced,
  loadNotifyState,
  parseDuration,
  saveNotifyState,
  type NotifyState,
} from '../core/notification/notify-state.js'
import { generateSummary } from '../core/notification/summary-generator.js'
import {
  KNOWN_CHANNELS,
  isKnownChannel,
  type ChannelId,
  type Notification,
  type NotificationChannel,
} from '../core/notification/types.js'
import { SecretNotFoundError, SecretStore } from '../core/secret-store.js'
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
  .action(async (options: { now?: boolean; hours: number }) => {
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
    const payload = generateSummary(db, {
      windowMs: options.hours * 3_600_000,
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
  if (channelId === 'telegram') return buildTelegramChannel(config)
  if (channelId === 'webhook') return buildWebhookChannel(config)
  if (channelId === 'system') return new SystemNotifyChannel()
  console.error(
    red('error: ') +
      `${channelId} channel ships in C11b-2 (#235) — only telegram / webhook / system are implemented`,
  )
  return null
}

async function buildWebhookChannel(
  config: Awaited<ReturnType<typeof loadNotifyConfig>>,
): Promise<WebhookChannel | null> {
  const wh = channelConfig(config, 'webhook')
  if (!wh) {
    console.error(red('error: ') + 'webhook block missing from notify.yaml')
    return null
  }
  if (!wh.webhook_url_ref) {
    console.error(red('error: ') + 'webhook.webhook_url_ref is unset')
    console.error(
      dim('  → store the URL: `foreman secrets add ' + 'webhook-url' + '`'),
    )
    return null
  }
  const db = getDb()
  const store = new SecretStore(db, loadOrCreateSecretsMasterKey())
  let url: string
  try {
    url = store.get(wh.webhook_url_ref)
  } catch (err) {
    if (err instanceof SecretNotFoundError) {
      console.error(
        red('error: ') +
          `secret '${wh.webhook_url_ref}' not found — \`foreman secrets add ${wh.webhook_url_ref}\``,
      )
      return null
    }
    throw err
  }
  let signingSecret: string | undefined
  if (wh.signing_secret_ref) {
    try {
      signingSecret = store.get(wh.signing_secret_ref)
    } catch (err) {
      if (!(err instanceof SecretNotFoundError)) throw err
      // Optional — fall through without signing
    }
  }
  return new WebhookChannel({ url, signingSecret })
}

async function buildTelegramChannel(
  config: Awaited<ReturnType<typeof loadNotifyConfig>>,
): Promise<TelegramChannel | null> {
  const tg = channelConfig(config, 'telegram')
  if (!tg) {
    console.error(red('error: ') + 'telegram block missing from notify.yaml')
    return null
  }
  if (!tg.bot_token_ref) {
    console.error(red('error: ') + 'telegram.bot_token_ref is unset')
    console.error(
      dim('  → store the token: `foreman secrets add ' + (tg.bot_token_ref ?? 'telegram-bot-token') + '`'),
    )
    return null
  }
  if (!tg.chat_id) {
    console.error(red('error: ') + 'telegram.chat_id is unset')
    console.error(
      dim('  → message your bot once, then `curl https://api.telegram.org/bot<token>/getUpdates`'),
    )
    return null
  }
  const db = getDb()
  const store = new SecretStore(db, loadOrCreateSecretsMasterKey())
  let token: string
  try {
    token = store.get(tg.bot_token_ref)
  } catch (err) {
    if (err instanceof SecretNotFoundError) {
      console.error(
        red('error: ') +
          `secret '${tg.bot_token_ref}' not found — \`foreman secrets add ${tg.bot_token_ref}\``,
      )
      return null
    }
    throw err
  }
  return new TelegramChannel({
    botToken: token,
    chatId: tg.chat_id,
    maxPolls: 0, // CLI shouldn't poll; only used for one-shot sends
  })
}

void ulid // re-export reservation for future cli verbs (silence, mute …)
