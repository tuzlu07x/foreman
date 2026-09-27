import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runInit } from '../../src/cli/init.js'
import { checkLlmCredentials, llmCredentialSlots } from '../../src/core/doctor.js'
import { findPreset, loadLlmPresets } from '../../src/core/llm-provider-presets.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { closeDb, getDb } from '../../src/db/client.js'
import { loadOrCreateSecretsMasterKey } from '../../src/identity/master-key.js'
import { persistForemanLlmChoice } from '../../src/tui/setup-wizard/foreman-llm-logic.js'
import type { WizardServices } from '../../src/tui/setup-wizard/types.js'

// =============================================================================
// Doctor's llm_credentials check for OpenAI-compatible and Ollama brains.
//
// llmCredentialSlots maps each provider to the fields it really uses: the
// wizard writes OpenAI-compatible preset credentials as key_secret /
// endpoint_secret (the schema's own names), with secret_name still honoured
// for older llm.yaml files.
//
// But this build has no LLM client for either provider (buildLlmClient throws
// LlmProviderUnavailableError; `foreman start` falls back to heuristics), so
// checkLlmCredentials must warn for them rather than report stored
// credentials as "ok". All secret values are fakes.
// =============================================================================

describe('llmCredentialSlots', () => {
  it('reads key_secret / endpoint_secret for openai_compatible', () => {
    expect(
      llmCredentialSlots('openai_compatible', {
        key_secret: 'deepseek-api-key',
        endpoint_secret: 'deepseek-endpoint',
      }),
    ).toEqual({
      keySecret: 'deepseek-api-key',
      keyField: 'key_secret',
      endpointSecret: 'deepseek-endpoint',
      keyOptional: false,
    })
  })

  it('falls back to secret_name for an older openai_compatible block', () => {
    expect(llmCredentialSlots('openai_compatible', { secret_name: 'my-key' }).keySecret).toBe(
      'my-key',
    )
  })

  it('treats a keyless Ollama block as keyless', () => {
    expect(llmCredentialSlots('ollama', { secret_name: null })).toMatchObject({
      keySecret: null,
      keyOptional: true,
    })
  })
})

describe('checkLlmCredentials for brains without a runtime client', () => {
  let tmp: string
  let previousHome: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'foreman-doctor-compat-'))
    previousHome = process.env.FOREMAN_HOME
    process.env.FOREMAN_HOME = tmp
    runInit()
  })

  afterEach(() => {
    closeDb()
    if (previousHome === undefined) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = previousHome
    rmSync(tmp, { recursive: true, force: true })
  })

  function store(): SecretStore {
    return new SecretStore(getDb(), loadOrCreateSecretsMasterKey())
  }

  function expectNoRuntimeWarning(provider: string): void {
    const r = checkLlmCredentials()
    expect(r.status).toBe('warn')
    expect(r.message).toContain(`LLM provider ${provider} has no client in this build yet`)
    expect(r.message).toContain('heuristic-only')
    expect(r.remediation).toContain('anthropic, openai or gemini')
  }

  it('warns for an OpenAI-compatible preset even with its credentials stored', () => {
    const preset = findPreset(loadLlmPresets(), 'deepseek')
    expect(preset).not.toBeNull()
    persistForemanLlmChoice({
      services: {
        llmConfigPath: join(tmp, 'llm.yaml'),
        secretStore: store(),
      } as unknown as WizardServices,
      choice: 'preset',
      ollamaModel: null,
      preset,
      presetKey: 'fake-deepseek-key-000',
    })
    // Used to report "ok — credentials present (deepseek-api-key)".
    expectNoRuntimeWarning('openai_compatible')
  })

  it('warns for an older secret_name-style openai_compatible block', () => {
    store().add('legacy-compat-key', 'fake-legacy-key')
    writeFileSync(
      join(tmp, 'llm.yaml'),
      `enabled: true
provider: openai_compatible
model: m
credentials:
  openai_compatible:
    secret_name: legacy-compat-key
`,
      'utf-8',
    )
    expectNoRuntimeWarning('openai_compatible')
  })

  it('warns for a keyless Ollama brain', () => {
    writeFileSync(
      join(tmp, 'llm.yaml'),
      `enabled: true
provider: ollama
model: llama3.2:3b
credentials:
  ollama:
    secret_name: null
    endpoint: http://localhost:11434
`,
      'utf-8',
    )
    expectNoRuntimeWarning('ollama')
  })

  it('stays ok when the LLM switch is off', () => {
    writeFileSync(
      join(tmp, 'llm.yaml'),
      'enabled: false\nprovider: ollama\nmodel: m\n',
      'utf-8',
    )
    expect(checkLlmCredentials().status).toBe('ok')
  })
})
