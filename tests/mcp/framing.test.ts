import { describe, expect, it } from 'vitest'
import {
  createDecoder,
  decodeMessage,
  encodeMessage,
} from '../../src/mcp/framing.js'
import {
  CallToolRequestSchema,
  isForemanMethod,
  isNotification,
  isRequest,
  type JSONRPCRequest,
} from '../../src/mcp/types.js'

const sampleCallTool: JSONRPCRequest = {
  jsonrpc: '2.0',
  id: 42,
  method: 'tools/call',
  params: {
    name: 'read_file',
    arguments: { path: 'src/auth.ts' },
  },
}

describe('encode / decode', () => {
  it('round-trips a tools/call request', () => {
    const line = encodeMessage(sampleCallTool)
    expect(line.endsWith('\n')).toBe(true)
    const parsed = decodeMessage(line)
    expect(parsed).toEqual(sampleCallTool)
    // Bonus: the inner params should also pass the SDK's CallToolRequest schema.
    const inner = CallToolRequestSchema.safeParse({
      method: sampleCallTool.method,
      params: sampleCallTool.params,
    })
    expect(inner.success).toBe(true)
  })

  it('returns null for malformed JSON', () => {
    expect(decodeMessage('not json {{{')).toBeNull()
    expect(decodeMessage('')).toBeNull()
    expect(decodeMessage('   ')).toBeNull()
  })

  it('returns null when the schema rejects the message', () => {
    expect(decodeMessage(JSON.stringify({ jsonrpc: '1.0' }))).toBeNull()
    expect(decodeMessage(JSON.stringify({ method: 'no-jsonrpc-version' }))).toBeNull()
  })

  it('discriminates requests vs notifications vs responses', () => {
    const req = decodeMessage(JSON.stringify(sampleCallTool))!
    expect(isRequest(req)).toBe(true)
    expect(isNotification(req)).toBe(false)

    const notif = decodeMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled' }),
    )!
    expect(notif).not.toBeNull()
    expect(isNotification(notif)).toBe(true)
    expect(isRequest(notif)).toBe(false)
  })
})

describe('MessageDecoder streaming', () => {
  it('reassembles a message split across chunks', () => {
    const decoder = createDecoder()
    const line = encodeMessage(sampleCallTool)
    const first = decoder.push(line.slice(0, 10))
    expect(first.messages).toHaveLength(0)
    expect(decoder.remainder().length).toBe(10)
    const second = decoder.push(line.slice(10))
    expect(second.messages).toEqual([sampleCallTool])
    expect(decoder.remainder()).toBe('')
  })

  it('splits multiple messages glued together in one chunk', () => {
    const decoder = createDecoder()
    const a = encodeMessage(sampleCallTool)
    const b = encodeMessage({ ...sampleCallTool, id: 43 })
    const result = decoder.push(a + b)
    expect(result.messages.map((m) => 'id' in m && m.id)).toEqual([42, 43])
    expect(result.rejected).toEqual([])
  })

  it('collects schema-invalid lines under rejected without dropping the rest', () => {
    const decoder = createDecoder()
    const ok = encodeMessage(sampleCallTool)
    const bad = '{"jsonrpc":"1.0","method":"x"}\n'
    const garbage = 'not-json\n'
    const result = decoder.push(ok + bad + garbage)
    expect(result.messages).toEqual([sampleCallTool])
    expect(result.rejected).toEqual([
      '{"jsonrpc":"1.0","method":"x"}',
      'not-json',
    ])
  })

  it('ignores blank lines between messages', () => {
    const decoder = createDecoder()
    const line = encodeMessage(sampleCallTool)
    const result = decoder.push(`\n\n${line}\n${line}`)
    expect(result.messages).toHaveLength(2)
  })

  it('accepts Buffer chunks too', () => {
    const decoder = createDecoder()
    const result = decoder.push(Buffer.from(encodeMessage(sampleCallTool)))
    expect(result.messages).toEqual([sampleCallTool])
  })
})

describe('isForemanMethod', () => {
  it.each([
    ['initialize', true],
    ['tools/list', true],
    ['tools/call', true],
    ['prompts/get', true],
    ['resources/subscribe', true],
    ['sampling/createMessage', false],
    ['nonsense', false],
  ])('classifies %s as %s', (method, expected) => {
    expect(isForemanMethod(method)).toBe(expected)
  })
})
