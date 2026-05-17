import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  parseRegistryText,
  RegistryValidationError,
} from '../../src/core/registry-catalog.js'

// =============================================================================
// Regression for #276 — `foreman setup` must NOT crash with a raw React stack
// when the bundled / cached registry fails schema validation. The wizard's
// useMemo(loadActiveRegistry) call throws synchronously inside render, so
// the fix moves a try/catch + friendly error BEFORE the wizard mounts.
//
// This file pins two things:
//   1. The error path the pre-flight catches (RegistryValidationError carries
//      structured issues we can show to the user).
//   2. The error shape produced by the real bundled registry parser when it
//      meets a forward-compat field (the original repro: stale parser meets
//      newer JSON with extra "secret_projection").
// =============================================================================

const PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
)

describe('setup pre-flight: registry validation (#276)', () => {
  it('the bundled registry parses cleanly with the current schema', () => {
    const path = join(PROJECT_ROOT, 'registry', 'agents.json')
    expect(existsSync(path)).toBe(true)
    const text = readFileSync(path, 'utf-8')
    // No throw — this is the happy path the pre-flight relies on for new
    // users who haven't run `foreman registry update`.
    expect(() => parseRegistryText(text, path)).not.toThrow()
  })

  it('catches schema mismatches as RegistryValidationError with structured issues', () => {
    // Simulate the exact #276 repro: registry JSON has a field the (older)
    // parser doesn't know about. The strict() Zod schema rejects it.
    const malformed = JSON.stringify({
      version: 1,
      agents: [
        {
          id: 'demo',
          name: 'Demo',
          tagline: 'x',
          homepage: 'https://x.com',
          install: { npm: null, brew: null },
          config_paths: [],
          required_secrets: [],
          optional_secrets: [],
          mcp_compatible: true,
          supported_versions: '*',
          min_foreman_version: '0.1.2',
          this_field_is_unknown: true, // ← forward-compat field
        },
      ],
    })
    try {
      parseRegistryText(malformed, '/tmp/agents.json')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryValidationError)
      const e = err as RegistryValidationError
      expect(e.message).toMatch(/failed schema validation/)
      expect(e.message).toContain('/tmp/agents.json') // #270: actual path
      expect(e.issues.length).toBeGreaterThan(0)
      // The friendly pre-flight output uses these per-issue lines.
      const issueText = e.issues.map((i) => `${i.path}: ${i.message}`).join('\n')
      expect(issueText).toMatch(/Unrecognized key|unknown/i)
    }
  })

  it('catches JSON parse errors as RegistryValidationError too (same handler covers both)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'foreman-preflight-'))
    try {
      const path = join(tmp, 'broken.json')
      const broken = '{ "broken": true'
      try {
        parseRegistryText(broken, path)
        throw new Error('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(RegistryValidationError)
        const e = err as RegistryValidationError
        expect(e.message).toContain('is not valid JSON')
        expect(e.message).toContain(path)
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
