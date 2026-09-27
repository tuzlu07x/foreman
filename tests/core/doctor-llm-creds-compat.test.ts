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
// The setup wizard writes OpenAI-compatible preset credentials as
// `key_secret` / `endpoint_secret` (the schema's own names), but doctor only
// read `secret_name` — so it warned "openai_compatible.secret_name is unset"
// right after a successful preset setup. Doctor now reads the schema's names
// and still honours `secret_name` for existing hand-written llm.yaml files.
// All secret values are fakes.
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

  it('treats a keyless Ollama block as fine', () => {
    expect(llmCredentialSlots('ollama', { secret_name: null })).toMatchObject({
      keySecret: null,
      keyOptional: true,
    })
  })
})

describe('checkLlmCredentials for wizard-written presets', () => {
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

  it('is ok right after the wizard saves a preset', () => {
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
    const r = checkLlmCredentials()
    expect(r.status).toBe('ok')
    expect(r.message).toContain('deepseek-api-key')
  })

  it('still accepts an existing llm.yaml that uses secret_name', () => {
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
    expect(checkLlmCredentials().status).toBe('ok')
  })

  it('warns when the endpoint secret is missing', () => {
    store().add('compat-key', 'fake-compat-key')
    writeFileSync(
      join(tmp, 'llm.yaml'),
      `enabled: true
provider: openai_compatible
model: m
credentials:
  openai_compatible:
    key_secret: compat-key
    endpoint_secret: compat-endpoint
`,
      'utf-8',
    )
    const r = checkLlmCredentials()
    expect(r.status).toBe('warn')
    expect(r.message).toContain('compat-endpoint')
  })

  it('names key_secret when nothing is configured for openai_compatible', () => {
    writeFileSync(
      join(tmp, 'llm.yaml'),
      `enabled: true
provider: openai_compatible
model: m
credentials:
  openai_compatible: {}
`,
      'utf-8',
    )
    const r = checkLlmCredentials()
    expect(r.status).toBe('warn')
    expect(r.message).toContain('openai_compatible.key_secret is unset')
  })

  it('is ok for a keyless Ollama brain', () => {
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
    expect(checkLlmCredentials().status).toBe('ok')
  })
})
