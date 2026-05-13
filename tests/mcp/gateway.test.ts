import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import {
  AgentAlreadyAttachedError,
  AgentNotAttachedError,
  MCPGateway,
} from '../../src/mcp/gateway.js'
import type { JSONRPCMessage } from '../../src/mcp/types.js'

const FAKE_CHILD = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/fake-mcp-child.mjs',
)

function waitForMessage(
  bus: EventBus<ForemanEventMap>,
  agentId: string,
  predicate: (msg: JSONRPCMessage) => boolean,
  timeoutMs = 2000,
): Promise<JSONRPCMessage> {
  return new Promise((resolveFn, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error(`timeout waiting for message from ${agentId}`))
    }, timeoutMs)
    const off = bus.on('agent:message', (e) => {
      if (e.agentId !== agentId) return
      const msg = e.message as JSONRPCMessage
      if (!predicate(msg)) return
      clearTimeout(timer)
      off()
      resolveFn(msg)
    })
  })
}

describe('MCPGateway with fake stdio child', () => {
  let bus: EventBus<ForemanEventMap>
  let gateway: MCPGateway

  beforeEach(() => {
    bus = new EventBus<ForemanEventMap>()
    gateway = new MCPGateway(bus)
  })

  afterEach(() => {
    gateway.dispose()
  })

  it('round-trips tools/list and surfaces the response on the bus', async () => {
    gateway.attach('fake', { command: process.execPath, args: [FAKE_CHILD] })
    const pending = waitForMessage(
      bus,
      'fake',
      (msg) => 'id' in msg && msg.id === 1 && 'result' in msg,
    )
    gateway.send('fake', { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const response = (await pending) as unknown as {
      id: number
      result: { tools: unknown[] }
    }
    expect(response.result.tools).toHaveLength(1)
  })

  it('round-trips tools/call and echoes back the argument', async () => {
    gateway.attach('fake', { command: process.execPath, args: [FAKE_CHILD] })
    const pending = waitForMessage(
      bus,
      'fake',
      (msg) => 'id' in msg && msg.id === 7 && 'result' in msg,
    )
    gateway.send('fake', {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'hello kanka' } },
    })
    const response = (await pending) as unknown as {
      result: { content: { type: string; text: string }[] }
    }
    expect(response.result.content[0]?.text).toBe('hello kanka')
  })

  it('throws AgentAlreadyAttachedError on duplicate attach', () => {
    gateway.attach('fake', { command: process.execPath, args: [FAKE_CHILD] })
    expect(() =>
      gateway.attach('fake', { command: process.execPath, args: [FAKE_CHILD] }),
    ).toThrow(AgentAlreadyAttachedError)
  })

  it('throws AgentNotAttachedError when sending to an unknown agent', () => {
    expect(() =>
      gateway.send('ghost', { jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    ).toThrow(AgentNotAttachedError)
  })

  it('emits agent:heartbeat (inactive) and agent:disconnected when the child exits', async () => {
    gateway.attach('fake', { command: process.execPath, args: [FAKE_CHILD] })
    const heartbeat = vi.fn()
    const disconnect = vi.fn()
    bus.on('agent:heartbeat', heartbeat)
    bus.on('agent:disconnected', disconnect)
    const ready = waitForMessage(bus, 'fake', () => true)
    gateway.send('fake', { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    await ready
    gateway.detach('fake')
    await new Promise((r) => setTimeout(r, 100))
    expect(heartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'fake', status: 'inactive' }),
    )
    expect(disconnect).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'fake' }),
    )
    expect(gateway.isAttached('fake')).toBe(false)
  })

  it('detach() of an unknown agent is a no-op', () => {
    expect(() => gateway.detach('ghost')).not.toThrow()
  })

  it('attached() lists every live agent', () => {
    gateway.attach('a', { command: process.execPath, args: [FAKE_CHILD] })
    gateway.attach('b', { command: process.execPath, args: [FAKE_CHILD] })
    expect(gateway.attached().sort()).toEqual(['a', 'b'])
  })
})
