import { describe, expect, it } from 'vitest'
import {
  checkDiscordBot,
  checkSlackAppToken,
  checkTelegramBot,
  describeFailedTokenCheck,
} from '../../../src/core/notification/token-checks.js'
import { runMcpOAuthLogin } from '../../../src/core/mcp-hub/oauth-login.js'

// QA #657 L14 — offline, `notify approval-bot` said "Telegram rejected
// that token", `slack-interactive` "Slack rejected the app token", and
// `mcp login` "no OAuth authorization-server metadata … the server may
// not support MCP OAuth". None of them had reached anything.
const offline = async (): Promise<Response> => {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
}
const answer = (status: number, body: unknown) => async (): Promise<Response> =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('token checks', () => {
  it('tells an unreachable service apart from a rejected token', async () => {
    const tg = await checkTelegramBot('123:abc', offline)
    expect(tg).toEqual({ status: 'unreachable', detail: 'fetch failed: ENOTFOUND' })
    expect(describeFailedTokenCheck('Telegram', 'approval bot token', tg as never)).toBe(
      "couldn't reach Telegram to check the approval bot token (fetch failed: ENOTFOUND). Check the network connection, or re-run with --no-verify to skip this check.",
    )
    expect((await checkSlackAppToken('xapp-1', offline)).status).toBe('unreachable')
    expect((await checkDiscordBot('a.b.c', offline)).status).toBe('unreachable')
  })

  it('still reports a real rejection as one', async () => {
    const tg = await checkTelegramBot('123:abc', answer(401, { ok: false, description: 'Unauthorized' }))
    expect(tg).toEqual({ status: 'rejected', detail: 'Unauthorized' })
    expect(describeFailedTokenCheck('Telegram', 'approval bot token', tg as never)).toBe(
      'Telegram rejected the approval bot token (Unauthorized). Re-run with --no-verify to skip this check.',
    )
    expect(await checkSlackAppToken('xapp-1', answer(200, { ok: false, error: 'invalid_auth' }))).toEqual({
      status: 'rejected',
      detail: 'invalid_auth',
    })
    expect(await checkDiscordBot('a.b.c', answer(401, {}))).toEqual({ status: 'rejected', detail: 'HTTP 401' })
  })

  it('returns what a working token says', async () => {
    expect(await checkTelegramBot('123:abc', answer(200, { ok: true, result: { username: 'fm_approvals_bot' } }))).toEqual({
      status: 'ok',
      value: { username: 'fm_approvals_bot' },
    })
  })
})

describe('mcp OAuth login offline', () => {
  it("says it couldn't reach the server instead of blaming it", async () => {
    await expect(
      runMcpOAuthLogin({
        server: 'hosted',
        serverUrl: 'https://mcp.example.test/mcp',
        presentAuthUrl: () => undefined,
        fetchFn: offline,
      }),
    ).rejects.toThrow("OAuth login for 'hosted' failed: couldn't reach https://mcp.example.test (fetch failed: ENOTFOUND) — check the network connection and try again")
  })
})
