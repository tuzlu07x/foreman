import { describe, expect, it } from 'vitest'
import { endpointPasteWarning, servicePasteWarning } from '../../src/tui/setup-wizard/paste-checks.js'

// QA #657 L7 — the wizard took `notatoken` as a Telegram token and
// `not a url` as a custom endpoint without a warning.
describe('wizard paste checks', () => {
  it('flags an endpoint that is not an http(s) URL', () => {
    expect(endpointPasteWarning('not a url')).toContain("doesn't look like an http(s) URL")
    expect(endpointPasteWarning('ftp://host/x')).toContain("doesn't look like")
    expect(endpointPasteWarning('http://localhost:11434')).toBeNull()
    expect(endpointPasteWarning(' https://api.groq.com/openai/v1 ')).toBeNull()
  })

  it('flags service secrets with the wrong shape', () => {
    expect(servicePasteWarning('telegram-bot-token', 'notatoken')).toContain('a Telegram bot token')
    expect(servicePasteWarning('telegram-bot-token', '123456789:AAHfake_token-abcdefghijklmnopqrstuvwxyz')).toBeNull()
    expect(servicePasteWarning('telegram-chat-id', '-1001234567890')).toBeNull()
    expect(servicePasteWarning('telegram-chat-id', 'my chat')).toContain('a Telegram chat id')
    expect(servicePasteWarning('slack-bot-token', 'xoxp-user')).toContain('a Slack user token (xoxp-…), not a Slack bot token')
    expect(servicePasteWarning('github-pat', 'ghp_' + 'a'.repeat(36))).toBeNull()
  })

  // The value isn't saved yet when this shows (the Services step holds it
  // back for a second Enter), so the check itself doesn't claim it was.
  it('flags a Discord public key pasted as the bot token without claiming it was saved', () => {
    const warning = servicePasteWarning('discord-bot-token', 'f'.repeat(64))
    expect(warning).toBe(
      "that's the Public Key, not a Discord bot token: the bot token is under discord.com/developers → your app → Bot → Reset Token → Copy (three dot-separated parts).",
    )
    expect(warning).not.toContain('Saved')
  })

  // Real-services test (2.3.0): the other values on the same settings page.
  it('says which look-alike was pasted and where the right value is', () => {
    expect(servicePasteWarning('slack-bot-token', 'xapp-1-A0FAKE-123-abc')).toMatch(
      /^that's Slack's app-level token \(xapp-…\).*OAuth & Permissions → Bot User OAuth Token\.$/,
    )
    expect(servicePasteWarning('discord-bot-token', '1554426741206945862')).toContain("that's the Application ID")
    expect(servicePasteWarning('discord-bot-token', 'a'.repeat(32))).toContain('OAuth2 Client Secret')
    expect(servicePasteWarning('telegram-bot-token', '123456789')).toContain("that's a chat id")
    expect(servicePasteWarning('telegram-chat-id', '123456789:AAHfake_token-abcdefghijklmnopqrstuvwxyz')).toContain(
      "that's the bot token",
    )
    // Anything else keeps the generic line.
    expect(servicePasteWarning('discord-bot-token', 'nope')).toBe(
      "that doesn't look like a Discord bot token (three dot-separated parts).",
    )
  })

  it('says nothing about secrets it has no shape for', () => {
    expect(servicePasteWarning('atlassian-api-token', 'anything')).toBeNull()
  })
})
