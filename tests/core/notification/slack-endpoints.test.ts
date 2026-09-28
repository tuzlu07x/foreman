import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { approvalSigner } from '../../../src/core/approval-token.js'
import { SlackChannel } from '../../../src/core/notification/channels/slack.js'
import { SLACK_ENDPOINTS, slackEndpoints } from '../../../src/core/notification/channels/slack-endpoints.js'
import { SlackSocketListener } from '../../../src/core/notification/channels/slack-socket.js'
import { SlackMirror } from '../../../src/core/org/comms-mirror.js'
import { fakeSocketServer, httpRecorder, settle } from './fake-socket.js'

// =============================================================================
// FOREMAN_TEST_SLACK_ORIGIN: the QA suite's fake Slack on 127.0.0.1, and
// nothing else (qa/support/fake-slack.ts, docs/qa.md).
// =============================================================================

const ORIGIN = 'http://127.0.0.1:43123'
const env = (value: string | undefined) => ({ FOREMAN_TEST_SLACK_ORIGIN: value })

describe('slackEndpoints', () => {
  it('is slack.com unless the override is set', () => {
    expect(slackEndpoints({})).toEqual({
      api: 'https://slack.com/api',
      replyUrlPrefix: 'https://hooks.slack.com/',
      socketUrlPrefix: 'wss://',
    })
  })

  it('points at a fake Slack on 127.0.0.1', () => {
    expect(slackEndpoints(env(ORIGIN))).toEqual({
      api: `${ORIGIN}/api`,
      replyUrlPrefix: `${ORIGIN}/hooks/`,
      socketUrlPrefix: 'ws://127.0.0.1:43123/',
    })
  })

  it.each([
    'https://127.0.0.1:43123',
    'http://localhost:43123',
    'http://127.0.0.2:43123',
    'http://10.0.0.1:43123',
    'http://evil.example:43123',
    'http://127.0.0.1:43123/',
    'http://127.0.0.1:43123/api',
    'http://user:pw@127.0.0.1:43123',
    'http://127.0.0.1',
    'http://127.0.0.1:0',
    'http://127.0.0.1:70000',
    ' http://127.0.0.1:43123',
    'http://127.0.0.1:43123.evil.example',
    '',
  ])('ignores %j', (value) => {
    expect(slackEndpoints(env(value))).toEqual(SLACK_ENDPOINTS)
  })
})

describe('Slack clients under the override', () => {
  const listeners: SlackSocketListener[] = []
  afterEach(async () => {
    for (const l of listeners.splice(0)) await l.stop()
  })

  it('posts messages and mirrors to the fake Web API', async () => {
    const api = httpRecorder(() => ({ body: { ok: true, channel: 'C1', ts: '1.1' } }))
    const endpoints = slackEndpoints(env(ORIGIN))
    const channel = new SlackChannel({ target: { kind: 'bot', token: 'xoxb-test', channel: '#alerts' }, fetchImpl: api.fetchImpl, endpoints })
    await channel.send({ id: 'n1', level: 'info', requestId: null, title: 't', body: 'b', actions: [], agentBlocking: false } as never)
    await new SlackMirror('xoxb-test', api.fetchImpl, endpoints).post('#marketing', { author: 'cmo', channelLabel: '#marketing', kind: 'message', text: 'hi' })
    expect(api.calls.map((c) => c.url)).toEqual([`${ORIGIN}/api/chat.postMessage`, `${ORIGIN}/api/chat.postMessage`])
  })

  it('takes only a ws:// socket on the same origin, and replies only under <origin>/hooks/', async () => {
    const sign = approvalSigner(randomBytes(32))
    let socketUrl = 'wss://wss-primary.slack.com/link/?ticket=1'
    const api = httpRecorder((url) => (url.endsWith('/apps.connections.open') ? { body: { ok: true, url: socketUrl } } : { body: 'ok' }))
    const server = fakeSocketServer()
    const listener = new SlackSocketListener({
      appToken: 'xapp-test',
      allowedUserIds: ['U0OWNER1'],
      sign,
      fetchImpl: api.fetchImpl,
      socketFactory: server.factory,
      backoffMs: { min: 10, max: 20 },
      endpoints: slackEndpoints(env(ORIGIN)),
    })
    listeners.push(listener)
    listener.start(async () => {})
    // A real Slack socket URL is refused while the override is on…
    await settle(60)
    expect(server.sockets).toHaveLength(0)
    expect(api.calls[0]?.url).toBe(`${ORIGIN}/api/apps.connections.open`)
    // …and the fake's own socket is taken.
    socketUrl = 'ws://127.0.0.1:43123/socket?ticket=2'
    const socket = await server.connection(1)
    expect(socket.url).toBe(socketUrl)

    const slash = (responseUrl: string) =>
      socket.receive({ envelope_id: `e-${responseUrl}`, type: 'slash_commands', payload: { user_id: 'U0STRANGER', text: 'status', response_url: responseUrl } })
    slash('https://hooks.slack.com/commands/T1/1/x')
    slash(`${ORIGIN}/elsewhere/1`)
    slash(`${ORIGIN}/hooks/commands/1`)
    await settle(40)
    const replies = api.calls.filter((c) => !c.url.endsWith('/apps.connections.open')).map((c) => c.url)
    expect(replies).toEqual([`${ORIGIN}/hooks/commands/1`])
  })

  it('refuses a ws:// socket without the override', async () => {
    const api = httpRecorder(() => ({ body: { ok: true, url: 'ws://127.0.0.1:43123/socket' } }))
    const server = fakeSocketServer()
    const warnings: string[] = []
    const listener = new SlackSocketListener({
      appToken: 'xapp-test',
      allowedUserIds: ['U0OWNER1'],
      fetchImpl: api.fetchImpl,
      socketFactory: server.factory,
      onWarning: (w) => warnings.push(w),
      backoffMs: { min: 10, max: 20 },
      endpoints: slackEndpoints({}),
    })
    listeners.push(listener)
    listener.start(async () => {})
    await settle(60)
    expect(server.sockets).toHaveLength(0)
    expect(api.calls[0]?.url).toBe('https://slack.com/api/apps.connections.open')
    expect(warnings).toEqual(['Slack Socket Mode is unreachable. Foreman keeps retrying.'])
  })
})
