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
import { TelegramChannel } from '../core/notification/channels/telegram.js'
import type {
  ChannelId,
  Notification,
  NotificationChannel,
} from '../core/notification/types.js'
import { SecretNotFoundError, SecretStore } from '../core/secret-store.js'
import { closeDb, getDb } from '../db/client.js'
import { loadOrCreateSecretsMasterKey } from '../identity/master-key.js'
import { getForemanPaths } from '../utils/config.js'
import { dim, green, orange, red } from './colors.js'

export const notifyCommand = new Command('notify').description(
  'Out-of-band notification channels (Telegram primary)',
)

notifyCommand
  .command('status')
  .description('Show enabled channels + last 5 notifications')
  .action(() => {
    requireInitialised()
    const paths = getForemanPaths()
    const config = loadNotifyConfig(paths.notifyConfigPath)

    console.log(orange('channels'))
    const channels = Object.entries(config.channels)
    if (channels.length === 0) {
      console.log(`  ${dim('(no channels configured — `foreman notify enable telegram` to start)')}`)
    } else {
      for (const [id, ch] of channels) {
        if (!ch) continue
        const flag = ch.enabled ? green('●') : dim('○')
        const detail = describeChannel(ch)
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
    const paths = getForemanPaths()
    const config = existsSync(paths.notifyConfigPath)
      ? loadNotifyConfig(paths.notifyConfigPath)
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
    const config = loadNotifyConfig(paths.notifyConfigPath)
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
  .command('test <channel>')
  .description('Send a test notification to verify channel credentials')
  .action(async (channel: string) => {
    requireInitialised()
    const paths = getForemanPaths()
    const config = loadNotifyConfig(paths.notifyConfigPath)
    if (!isChannelEnabled(config, channel)) {
      console.error(
        red('error: ') +
          `${channel} is not enabled — run \`foreman notify enable ${channel}\` first`,
      )
      process.exit(1)
    }
    if (channel !== 'telegram') {
      console.error(
        red('error: ') +
          `${channel} channel ships in C11b (#235) — only telegram is implemented in this PR`,
      )
      process.exit(2)
    }

    const ch = await buildTelegramChannel(config)
    if (!ch) process.exit(1)

    const db = getDb()
    const service = new NotificationService({
      db,
      config,
      channels: new Map<ChannelId, NotificationChannel>([['telegram', ch]]),
    })

    const test: Omit<Notification, 'id'> = {
      level: 'info',
      requestId: null,
      title: 'Foreman test ✓',
      body: `Sent by foreman notify test telegram at ${new Date().toISOString()}`,
      actions: [],
      agentBlocking: false,
    }
    try {
      const res = await service.send('warning', test)
      const outcome = res.outcomes.get('telegram')
      if (outcome?.status === 'sent') {
        console.log(`${green('✓')} test message sent (message_id=${outcome.ref.channelMessageId})`)
      } else if (outcome?.status === 'failed') {
        console.error(red('error: ') + `delivery failed: ${outcome.error}`)
        process.exit(1)
      } else {
        console.error(
          red('error: ') +
            `delivery skipped: ${outcome?.status === 'skipped' ? outcome.reason : 'unknown'}`,
        )
        process.exit(1)
      }
    } finally {
      await service.shutdown()
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

function describeChannel(ch: ChannelToggle): string {
  const bits: string[] = []
  if (ch.bot_token_ref) bits.push(`token=${ch.bot_token_ref}`)
  if (ch.chat_id) bits.push(`chat=${ch.chat_id}`)
  if (ch.webhook_url_ref) bits.push(`webhook=${ch.webhook_url_ref}`)
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
