import { describe, expect, it } from 'vitest'
import { estimateCost, priceFor } from '../../../src/core/usage/pricing.js'
import { parseTaskUsage } from '../../../src/core/usage/task-usage.js'
import { usageEntriesFromLogs } from '../../../src/core/usage/otlp-receiver.js'

describe('pricing (#629)', () => {
  it('matches the longest model prefix and never guesses unknown models', () => {
    expect(priceFor('gpt-5-mini-2025-08-07')).toEqual({ input: 0.25, output: 2 })
    expect(priceFor('gpt-5-codex')).toEqual({ input: 1.25, output: 10 })
    expect(priceFor('anthropic/claude-sonnet-4-5')).toEqual({ input: 3, output: 15 })
    expect(priceFor('some-local-llama')).toBeNull()
    expect(estimateCost('some-local-llama', { input: 1000 })).toBeNull()
  })

  it('prices input, output and cache separately, and a bare total at a 3:1 mix', () => {
    expect(estimateCost('claude-sonnet-4', { input: 1_000_000, output: 1_000_000 })).toBeCloseTo(18)
    expect(estimateCost('claude-sonnet-4', { cacheRead: 1_000_000 })).toBeCloseTo(0.3)
    expect(estimateCost('gpt-5', { total: 1_000_000 })).toBeCloseTo(0.75 * 1.25 + 0.25 * 10)
  })
})

describe('parseTaskUsage (#629)', () => {
  it('reads a Claude JSON result', () => {
    const out = JSON.stringify({
      type: 'result',
      total_cost_usd: 0.0421,
      usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500 },
      modelUsage: { 'claude-sonnet-4-5': {} },
      result: 'done',
    })
    expect(parseTaskUsage(out)).toEqual({
      input: 1200,
      output: 340,
      cacheRead: 9000,
      cacheWrite: 500,
      costUsd: 0.0421,
      model: 'claude-sonnet-4-5',
    })
  })

  it("reads Codex's last `tokens used` line from stdout or stderr", () => {
    expect(parseTaskUsage('Added 6 tests.', 'tokens used: 1,234\n...\ntokens used\n12,345\n')).toEqual({ total: 12345 })
  })

  it('returns null for ordinary output', () => {
    expect(parseTaskUsage('All green. 4 tests passed.')).toBeNull()
    expect(parseTaskUsage('{"ok":true}')).toBeNull()
  })
})

describe('usageEntriesFromLogs (#629)', () => {
  const kv = (key: string, value: unknown) => ({
    key,
    value: typeof value === 'number' ? (Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }) : { stringValue: value },
  })

  it('keeps counts from Claude api_request and Codex response.completed, nothing else', () => {
    const payload = {
      resourceLogs: [
        {
          resource: { attributes: [kv('service.name', 'claude-code'), kv('foreman.agent', 'writer-bot'), kv('foreman.task', '42')] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1790000000000000000',
                  body: { stringValue: 'claude_code.api_request' },
                  attributes: [
                    kv('event.name', 'api_request'),
                    kv('model', 'claude-sonnet-4-5'),
                    kv('input_tokens', 100),
                    kv('output_tokens', 50),
                    kv('cache_read_tokens', 1000),
                    kv('cache_creation_tokens', 10),
                    kv('cost_usd', 0.0123),
                    kv('session.id', 's-1'),
                  ],
                },
                { body: { stringValue: 'claude_code.user_prompt' }, attributes: [kv('prompt', 'secret plans')] },
              ],
            },
          ],
        },
        {
          resource: { attributes: [kv('service.name', 'codex_cli_rs')] },
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    kv('event.name', 'codex.sse_event'),
                    kv('event.kind', 'response.completed'),
                    kv('model', 'gpt-5-codex'),
                    kv('input_token_count', 5000),
                    kv('cached_token_count', 4000),
                    kv('output_token_count', 300),
                  ],
                },
                { attributes: [kv('event.name', 'codex.sse_event'), kv('event.kind', 'response.output_text.delta')] },
              ],
            },
          ],
        },
      ],
    }
    const entries = usageEntriesFromLogs(payload)
    expect(entries).toEqual([
      {
        agentId: 'writer-bot',
        source: 'telemetry',
        model: 'claude-sonnet-4-5',
        input: 100,
        output: 50,
        cacheRead: 1000,
        cacheWrite: 10,
        costUsd: 0.0123,
        taskRef: '42',
        sessionRef: 's-1',
        ts: 1790000000000,
      },
      {
        agentId: 'codex',
        source: 'telemetry',
        model: 'gpt-5-codex',
        input: 1000,
        cacheRead: 4000,
        output: 300,
        taskRef: null,
        sessionRef: null,
      },
    ])
    expect(JSON.stringify(entries)).not.toContain('secret plans')
  })

  it('ignores garbage', () => {
    expect(usageEntriesFromLogs(null)).toEqual([])
    expect(usageEntriesFromLogs({ resourceLogs: 'x' })).toEqual([])
    expect(usageEntriesFromLogs({ resourceLogs: [{ scopeLogs: [{ logRecords: [null, 3] }] }] })).toEqual([])
  })
})
