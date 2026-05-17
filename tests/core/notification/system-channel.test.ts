import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  SystemNotifyChannel,
  type SpawnImpl,
} from '../../../src/core/notification/channels/system.js'
import type { Notification } from '../../../src/core/notification/types.js'

// A minimal ChildProcess stub — enough surface for SystemNotifyChannel's
// `spawn().on('error', …)` + optional stdin writes.
function makeFakeChild(): {
  proc: ReturnType<typeof makeProc>
  writes: string[]
  ended: boolean
} {
  const writes: string[] = []
  let ended = false
  const emitter = new EventEmitter()
  function makeProc() {
    return Object.assign(emitter, {
      stdin: {
        write: (chunk: string) => writes.push(chunk),
        end: () => {
          ended = true
        },
      },
      stdout: null,
      stderr: null,
    })
  }
  return {
    proc: makeProc(),
    writes,
    get ended() {
      return ended
    },
  }
}

function makeNotification(
  overrides: Partial<Notification> = {},
): Notification {
  return {
    id: 'sys-1',
    level: 'critical',
    requestId: 'req-1',
    title: 'Hermes wants .env',
    body: 'Tap to decide.',
    actions: [],
    agentBlocking: false,
    ...overrides,
  }
}

describe('SystemNotifyChannel — platform routing', () => {
  it.each([
    ['darwin', 'osascript'],
    ['linux', 'notify-send'],
  ] as const)('spawns %s helper for platform %s', async (platform, expected) => {
    const calls: { cmd: string; args: readonly string[] }[] = []
    const fakeChild = makeFakeChild()
    const spawnImpl: SpawnImpl = (cmd, args) => {
      calls.push({ cmd, args })
      return fakeChild.proc as never
    }
    const channel = new SystemNotifyChannel({
      platform: platform as NodeJS.Platform,
      spawnImpl,
    })
    const ref = await channel.send(makeNotification())
    expect(ref.channelMessageId).toMatch(/^system-/)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.cmd).toBe(expected)
  })

  it('macOS osascript receives the AppleScript via stdin (avoids shell quoting)', async () => {
    const fakeChild = makeFakeChild()
    const spawnImpl: SpawnImpl = () => fakeChild.proc as never
    const channel = new SystemNotifyChannel({
      platform: 'darwin',
      spawnImpl,
    })
    await channel.send(makeNotification())
    expect(fakeChild.writes.join('')).toContain('display notification')
    expect(fakeChild.ended).toBe(true)
  })

  it('Linux notify-send maps critical level → --urgency critical', async () => {
    const calls: { args: readonly string[] }[] = []
    const fakeChild = makeFakeChild()
    const spawnImpl: SpawnImpl = (_cmd, args) => {
      calls.push({ args })
      return fakeChild.proc as never
    }
    const channel = new SystemNotifyChannel({
      platform: 'linux',
      spawnImpl,
    })
    await channel.send(makeNotification({ level: 'critical' }))
    expect(calls[0]!.args).toContain('--urgency')
    expect(calls[0]!.args).toContain('critical')
    expect(calls[0]!.args).toContain('--app-name=foreman')
  })

  it('Linux info level → --urgency low', async () => {
    const calls: { args: readonly string[] }[] = []
    const fakeChild = makeFakeChild()
    const spawnImpl: SpawnImpl = (_cmd, args) => {
      calls.push({ args })
      return fakeChild.proc as never
    }
    const channel = new SystemNotifyChannel({
      platform: 'linux',
      spawnImpl,
    })
    await channel.send(makeNotification({ level: 'info' }))
    expect(calls[0]!.args).toContain('low')
  })

  it('throws on unsupported platform (win32 — until v0.2 BurntToast)', async () => {
    const channel = new SystemNotifyChannel({
      platform: 'win32',
      spawnImpl: vi.fn() as never,
    })
    await expect(channel.send(makeNotification())).rejects.toThrow(/win32/)
  })

  it('isReady returns false on unsupported platform', async () => {
    const channel = new SystemNotifyChannel({
      platform: 'win32',
      spawnImpl: vi.fn() as never,
    })
    expect(await channel.isReady()).toBe(false)
  })

  it('isReady returns true on darwin + linux', async () => {
    expect(
      await new SystemNotifyChannel({ platform: 'darwin' }).isReady(),
    ).toBe(true)
    expect(
      await new SystemNotifyChannel({ platform: 'linux' }).isReady(),
    ).toBe(true)
  })

  it('listen is a no-op (returns immediately, never calls handler)', async () => {
    const channel = new SystemNotifyChannel({ platform: 'darwin' })
    const handler = vi.fn()
    await channel.listen(handler)
    expect(handler).not.toHaveBeenCalled()
    await channel.shutdown()
  })
})

describe('SystemNotifyChannel — dryRun + sanitisation', () => {
  it('dryRun skips spawn entirely', async () => {
    const spawnImpl = vi.fn() as never
    const channel = new SystemNotifyChannel({
      platform: 'darwin',
      spawnImpl,
      dryRun: true,
    })
    await channel.send(makeNotification())
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it('updateMessage sends a follow-up notification', async () => {
    const calls: { cmd: string }[] = []
    const fakeChild = makeFakeChild()
    const spawnImpl: SpawnImpl = (cmd) => {
      calls.push({ cmd })
      return fakeChild.proc as never
    }
    const channel = new SystemNotifyChannel({
      platform: 'darwin',
      spawnImpl,
    })
    await channel.updateMessage(
      { channelMessageId: 'sys-1' },
      'Resolved at 14:18',
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.cmd).toBe('osascript')
  })

  it('handles spawn ENOENT silently (osascript or notify-send missing)', async () => {
    const fakeChild = makeFakeChild()
    const spawnImpl: SpawnImpl = () => fakeChild.proc as never
    const channel = new SystemNotifyChannel({
      platform: 'darwin',
      spawnImpl,
    })
    await channel.send(makeNotification())
    // Simulate spawn error firing AFTER send returned
    fakeChild.proc.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    // No throw — handler is registered to silently swallow.
  })

  it('long titles + bodies are truncated to <=240 chars', async () => {
    const calls: { args: readonly string[] }[] = []
    const fakeChild = makeFakeChild()
    const spawnImpl: SpawnImpl = (_cmd, args) => {
      calls.push({ args })
      return fakeChild.proc as never
    }
    const channel = new SystemNotifyChannel({
      platform: 'linux',
      spawnImpl,
    })
    const longBody = 'x'.repeat(500)
    await channel.send(makeNotification({ body: longBody }))
    // Last two args are [title, body]
    const args = calls[0]!.args
    const body = args[args.length - 1]!
    expect(body.length).toBeLessThanOrEqual(240)
    expect(body.endsWith('…')).toBe(true)
  })
})
