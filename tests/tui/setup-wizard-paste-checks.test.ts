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
    expect(servicePasteWarning('slack-bot-token', 'xoxp-user')).toContain('a Slack bot token')
    expect(servicePasteWarning('github-pat', 'ghp_' + 'a'.repeat(36))).toBeNull()
  })

  // The value isn't saved yet when this shows (the Services step holds it
  // back for a second Enter), so the check itself doesn't claim it was.
  it('flags a Discord public key pasted as the bot token without claiming it was saved', () => {
    const warning = servicePasteWarning('discord-bot-token', 'f'.repeat(64))
    expect(warning).toBe("that doesn't look like a Discord bot token (three dot-separated parts).")
  })

  it('says nothing about secrets it has no shape for', () => {
    expect(servicePasteWarning('atlassian-api-token', 'anything')).toBeNull()
  })
})
