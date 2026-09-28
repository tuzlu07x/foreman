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
// for older llm.yaml files. Both run keyless when no key slot is named.
//
// checkLlmCredentials checks what the factory will read — the key slot and
// the base URL (endpoint_secret, endpoint, or Ollama's local default) — and
// that the URL is one the runtime client accepts. All secret values are
// fakes.
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
      keyOptional: true,
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

  it("reads Ollama's endpoint_secret (Step 1 stores the URL there)", () => {
    expect(llmCredentialSlots('ollama', { endpoint_secret: 'ollama-endpoint' }).endpointSecret).toBe(
      'ollama-endpoint',
    )
  })
})

describe('checkLlmCredentials for self-hosted brains', () => {
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

  function writeLlmYaml(body: string): void {
    writeFileSync(join(tmp, 'llm.yaml'), `enabled: true\n${body}`, 'utf-8')
  }

  it('is ok for an OpenAI-compatible preset saved by the wizard', () => {
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
    expect(r.message).toContain('openai_compatible configured')
    expect(r.message).toContain('endpoint from deepseek-endpoint')
    expect(r.message).toContain('key deepseek-api-key')
    // The URL itself stays out of the report.
    expect(r.message).not.toContain('api.deepseek.com')
  })

  it('warns when an older secret_name-style block has no base URL', () => {
    store().add('legacy-compat-key', 'fake-legacy-key')
    writeLlmYaml(`provider: openai_compatible
model: m
credentials:
  openai_compatible:
    secret_name: legacy-compat-key
`)
    const r = checkLlmCredentials()
    expect(r.status).toBe('warn')
    expect(r.message).toContain('has no base URL')
  })

  it('is ok for a keyless Ollama brain on the local default', () => {
    writeLlmYaml(`provider: ollama
model: llama3.2:3b
credentials:
  ollama:
    secret_name: null
    endpoint: http://localhost:11434
`)
    const r = checkLlmCredentials()
    expect(r.status).toBe('ok')
    expect(r.message).toContain('ollama configured (endpoint in llm.yaml, no API key)')
  })

  it('warns when the base URL is not http(s)', () => {
    writeLlmYaml(`provider: ollama
model: m
credentials:
  ollama:
    endpoint: file:///tmp/socket
`)
    const r = checkLlmCredentials()
    expect(r.status).toBe('warn')
    expect(r.message).toContain('base URL (endpoint in llm.yaml) is invalid')
    expect(r.remediation).toContain('http(s) URL')
  })

  it('warns when the endpoint secret is missing from the store', () => {
    writeLlmYaml(`provider: openai_compatible
model: m
credentials:
  openai_compatible:
    endpoint_secret: gone-endpoint
`)
    const r = checkLlmCredentials()
    expect(r.status).toBe('warn')
    expect(r.message).toContain('secret "gone-endpoint" is missing')
  })

  it('warns when an API key would travel over plain http to a remote host', () => {
    store().add('remote-key', 'fake-remote-key')
    writeLlmYaml(`provider: openai_compatible
model: m
credentials:
  openai_compatible:
    endpoint: http://gpu-box.example.test:8000/v1
    key_secret: remote-key
`)
    const r = checkLlmCredentials()
    expect(r.status).toBe('warn')
    expect(r.message).toContain('over plain http')
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
