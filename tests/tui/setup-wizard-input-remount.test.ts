import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// =============================================================================
// Regression for #219 — wizard's PasswordInput / TextInput must NOT keep the
// previous prompt's value when the wizard advances. The fix is React's `key=`
// trick: each value-entry input is keyed by its prompt id so React unmounts
// the old instance and mounts a fresh empty one between prompts.
//
// ink-testing-library can't fully emulate raw-mode stdin for @inkjs/ui inputs
// (they hook ink's useInput which needs an isTTY raw stream), so behavioral
// "type, advance, assert empty" tests aren't reliable here. Instead this
// test pins the source-level fix: each value-entry input MUST carry a stable
// `key=` derived from the current prompt. A refactor that strips the key
// (or accidentally hardcodes a constant) will trip this test.
// =============================================================================

const WIZARD_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/tui/setup-wizard.tsx',
)

function readWizard(): string {
  return readFileSync(WIZARD_PATH, 'utf-8')
}

describe('setup wizard input remount keys (#219)', () => {
  const source = readWizard()

  it('provider value PasswordInput is keyed by providerId + kind', () => {
    expect(source).toMatch(
      /<PasswordInput\s+[^>]*?key=\{\`prov:\$\{prompt\.providerId\}:\$\{prompt\.kind\}\`\}/,
    )
  })

  it('provider endpoint TextInput is keyed by providerId + kind', () => {
    expect(source).toMatch(
      /<TextInput\s+[^>]*?key=\{\`prov:\$\{prompt\.providerId\}:\$\{prompt\.kind\}\`\}/,
    )
  })

  it('service value PasswordInput is keyed by per-prompt secret name', () => {
    // #220 expanded the per-service prompt into a list (primary + extras),
    // so the key must vary per secret, not per service id.
    expect(source).toMatch(
      /<PasswordInput\s+[^>]*?key=\{\`service:\$\{prompt\.secretName\}\`\}/,
    )
  })

  it('agent-responsibility TextInput is keyed by agentId', () => {
    expect(source).toMatch(
      /<TextInput\s+[^>]*?key=\{\`agent-note:\$\{prompt\.agentId\}\`\}/,
    )
  })

  it('no input in the wizard renders without an explicit key prop', () => {
    // For every PasswordInput / TextInput tag opening, the next non-whitespace
    // characters must include a `key=` within the opening tag. This is a
    // defence-in-depth check: future inputs added to the wizard must also be
    // keyed, or they re-introduce #219.
    const openings = [
      ...source.matchAll(/<(PasswordInput|TextInput)\b([^>]*?)>/g),
    ]
    expect(openings.length).toBeGreaterThan(0)
    for (const match of openings) {
      const tag = match[1]
      const attrs = match[2] ?? ''
      expect(
        attrs.includes('key='),
        `<${tag}> in setup-wizard.tsx is missing a key prop (regressed #219). attrs=${attrs}`,
      ).toBe(true)
    }
  })
})
