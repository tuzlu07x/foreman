import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { StdioTransport } from '../../src/mcp/stdio-transport.js'

const DEAF_CHILD = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/deaf-mcp-child.mjs',
)

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntilDead(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return !isAlive(pid)
}

describe('StdioTransport shutdown', () => {
  // #594 — a child that closes stdin while still running makes the parent's
  // next write raise EPIPE. That marks the transport terminal, but the child
  // is very much alive, so stop() must still kill it. Conflating the two
  // leaks the process.
  it('still kills a child that closed its stdin but kept running', async () => {
    const errors: string[] = []
    const transport = new StdioTransport({
      command: process.execPath,
      args: [DEAF_CHILD],
      onMessage: () => {},
      onError: (err) => errors.push((err as NodeJS.ErrnoException).code ?? err.message),
    })

    transport.start()
    const pid = transport.pid()
    expect(pid).toBeDefined()
    await new Promise((r) => setTimeout(r, 300))
    expect(isAlive(pid!)).toBe(true)

    // Push hard enough that the closed pipe surfaces EPIPE rather than
    // sitting in the kernel buffer.
    for (let i = 0; i < 20 && transport.isAlive(); i++) {
      try {
        transport.send({
          jsonrpc: '2.0',
          id: i,
          method: 'tools/list',
          params: { pad: 'x'.repeat(50_000) },
        })
      } catch {
        break
      }
      await new Promise((r) => setTimeout(r, 40))
    }

    expect(errors).toContain('EPIPE')
    expect(transport.isAlive()).toBe(false)
    expect(isAlive(pid!)).toBe(true) // terminal transport, live child

    transport.stop()
    await expect(waitUntilDead(pid!)).resolves.toBe(true)
  })

  it('stop() kills a healthy child and is idempotent', async () => {
    const transport = new StdioTransport({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1 << 30)'],
      onMessage: () => {},
    })

    transport.start()
    const pid = transport.pid()!
    await new Promise((r) => setTimeout(r, 200))
    expect(isAlive(pid)).toBe(true)

    transport.stop()
    await expect(waitUntilDead(pid)).resolves.toBe(true)
    expect(() => transport.stop()).not.toThrow()
  })
})
