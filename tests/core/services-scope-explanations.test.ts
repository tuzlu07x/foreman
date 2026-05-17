import { describe, expect, it } from 'vitest'
import { loadBundledServices } from '../../src/core/registry-catalog.js'

// =============================================================================
// Regression for #221 — service setup_steps must SPELL OUT what each token
// scope grants. Listing raw scope names like "repo, read:user" assumes the
// user already knows GitHub's permission model, and pushes them to over-grant
// "because the wizard said so". These tests pin the explanation lines for
// the two services with non-obvious scopes (GitHub PAT, Slack OAuth).
// =============================================================================

const catalog = loadBundledServices()

describe('GitHub PAT setup steps explain each scope (#221)', () => {
  const github = catalog.services.find((s) => s.id === 'github')

  it('ships in the registry', () => {
    expect(github).toBeDefined()
  })

  it('includes a line explaining what `repo` grants', () => {
    expect(github!.setup_steps.join('\n')).toMatch(
      /repo\s+→\s+read \+ write to your repos/i,
    )
  })

  it('includes a line explaining what `read:user` grants', () => {
    expect(github!.setup_steps.join('\n')).toMatch(
      /read:user\s+→\s+read your profile/i,
    )
  })

  it('groups optional scopes separately so users do not over-grant', () => {
    const text = github!.setup_steps.join('\n')
    expect(text).toMatch(/Optional scopes/i)
    expect(text).toMatch(/read:org/)
    expect(text).toMatch(/workflow/)
  })

  it('reminds the user the token starts with ghp_ (format sanity)', () => {
    expect(github!.setup_steps.join('\n')).toMatch(/ghp_/)
  })
})

describe('Slack OAuth setup steps explain each scope (#221)', () => {
  const slack = catalog.services.find((s) => s.id === 'slack')

  it('ships in the registry', () => {
    expect(slack).toBeDefined()
  })

  it('includes a line explaining what `chat:write` grants', () => {
    expect(slack!.setup_steps.join('\n')).toMatch(
      /chat:write\s+→\s+post messages/i,
    )
  })

  it('includes a line explaining what `channels:read` grants', () => {
    expect(slack!.setup_steps.join('\n')).toMatch(
      /channels:read\s+→\s+list public channels/i,
    )
  })

  it('groups optional scopes separately', () => {
    const text = slack!.setup_steps.join('\n')
    expect(text).toMatch(/Optional bot scopes/i)
    expect(text).toMatch(/im:history/)
    expect(text).toMatch(/files:write/)
  })

  it('reminds the user the token starts with xoxb-', () => {
    expect(slack!.setup_steps.join('\n')).toMatch(/xoxb-/)
  })
})
