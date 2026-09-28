import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadLlmConfig } from '../../src/core/llm/config.js'
import { buildLlmClient } from '../../src/core/llm/factory.js'
import { loadOllamaModels } from '../../src/core/ollama-models.js'
import type { MachineCapability } from '../../src/core/machine-capability.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { createInMemoryDb } from '../../src/db/client.js'
import {
  initialOllamaBaseUrl,
  ollamaModelRows,
  orderCompatModels,
  persistForemanLlmChoice,
  validateBrainBaseUrl,
} from '../../src/tui/setup-wizard/foreman-llm-logic.js'
import type { WizardServices } from '../../src/tui/setup-wizard/types.js'

// =============================================================================
// Setup wizard, Foreman's brain on Ollama or an own OpenAI-compatible
// endpoint: what the model picker offers, and that what the wizard saves is
// what the LLM factory runs. All secrets are fakes; nothing is fetched.
// =============================================================================

const machine: MachineCapability = {
  os: 'linux',
  arch: 'x86_64',
  totalRamBytes: 16 * 1024 ** 3,
  freeRamBytes: 8 * 1024 ** 3,
  cpuCount: 8,
  freeDiskBytesHome: 100 * 1024 ** 3,
  gpu: { kind: 'none', vramBytes: null },
}

const live = (...ids: string[]): { id: string; label: string; slash_id: string }[] =>
  ids.map((id) => ({ id, label: id, slash_id: `ollama/${id}` }))

describe('ollamaModelRows', () => {
  const catalog = loadOllamaModels()

  it('puts pulled models first, then catalog models that fit, for a local server', () => {
    const { selectable, disabled } = ollamaModelRows({
      live: live('my-finetune:latest', 'llama3.2:3b'),
      catalog,
      machine,
      local: true,
    })
    expect(selectable.slice(0, 2).map((r) => [r.name, r.pulled])).toEqual([
      ['my-finetune:latest', true],
      ['llama3.2:3b', true],
    ])
    expect(selectable[1]!.detail).toContain('[installed]')
    // llama3.2:3b is pulled, so the catalog doesn't list it a second time.
    expect(selectable.filter((r) => r.name === 'llama3.2:3b')).toHaveLength(1)
    const notPulled = selectable.filter((r) => !r.pulled)
    expect(notPulled.length).toBeGreaterThan(0)
    expect(notPulled.every((r) => r.detail.includes('[needs ollama pull]'))).toBe(true)
    // A 671B model doesn't fit a 16 GB machine: listed, not selectable.
    expect(disabled.map((r) => r.name)).toContain('deepseek-r1:671b')
  })

  it('offers only the pulled models of a remote server', () => {
    const rows = ollamaModelRows({ live: live('qwen2.5:72b'), catalog, machine, local: false })
    expect(rows.selectable.map((r) => r.name)).toEqual(['qwen2.5:72b'])
    expect(rows.disabled).toEqual([])
  })
})

describe('orderCompatModels / validateBrainBaseUrl', () => {
  it("lists a preset's default model first", () => {
    const models = live('a', 'deepseek-chat', 'z')
    expect(orderCompatModels(models, 'deepseek-chat').map((m) => m.id)).toEqual(['deepseek-chat', 'a', 'z'])
    expect(orderCompatModels(models, undefined).map((m) => m.id)).toEqual(['a', 'deepseek-chat', 'z'])
  })

  it('accepts http(s) only and normalises the trailing slash', () => {
    expect(validateBrainBaseUrl(' http://127.0.0.1:8000/v1/ ')).toEqual({ ok: true, url: 'http://127.0.0.1:8000/v1' })
    expect(validateBrainBaseUrl('javascript:alert(1)')).toMatchObject({ ok: false })
    expect(validateBrainBaseUrl('')).toMatchObject({ ok: false })
  })
})

describe('persistForemanLlmChoice → buildLlmClient', () => {
  let sqlite: Database.Database
  let store: SecretStore
  let dir: string
  let services: WizardServices

  beforeEach(() => {
    const handle = createInMemoryDb()
    sqlite = handle.sqlite
    store = new SecretStore(handle.db, Buffer.alloc(32, 7))
    dir = mkdtempSync(join(tmpdir(), 'wizard-self-hosted-'))
    services = { llmConfigPath: join(dir, 'llm.yaml'), secretStore: store } as unknown as WizardServices
  })

  afterEach(() => {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('saves an Ollama brain on the typed URL, replacing Step 1’s endpoint secret', () => {
    store.add('ollama-endpoint', 'http://old-host:11434')
    writeFileSync(
      services.llmConfigPath,
      'enabled: true\nprovider: ollama\nmodel: m\ncredentials:\n  ollama:\n    endpoint_secret: ollama-endpoint\n',
      'utf-8',
    )
    // The URL screen starts from what the brain uses today.
    expect(initialOllamaBaseUrl(services)).toBe('http://old-host:11434')
    persistForemanLlmChoice({
      services,
      choice: 'ollama',
      ollamaModel: 'qwen2.5:7b',
      preset: null,
      presetKey: '',
      baseUrl: 'http://gpu-box.example.test:11434',
    })
    const config = loadLlmConfig(services.llmConfigPath)
    expect(config.provider).toBe('ollama')
    expect(config.model).toBe('qwen2.5:7b')
    expect(config.credentials.ollama?.endpoint).toBe('http://gpu-box.example.test:11434')
    expect(config.credentials.ollama?.endpoint_secret).toBeUndefined()
    const client = buildLlmClient(config, store)
    expect(Reflect.get(client, 'baseUrl')).toBe('http://gpu-box.example.test:11434/v1')
  })

  it('saves a keyed custom endpoint under the Step 1 custom slots', () => {
    persistForemanLlmChoice({
      services,
      choice: 'custom',
      ollamaModel: null,
      preset: null,
      presetKey: 'fake-custom-key-000',
      cloudModel: 'served-model',
      baseUrl: 'https://llm.example.test/v1',
    })
    const config = loadLlmConfig(services.llmConfigPath)
    expect(config.provider).toBe('openai_compatible')
    expect(config.model).toBe('served-model')
    expect(config.credentials.openai_compatible).toEqual({
      auth_mode: 'api_key',
      endpoint_secret: 'openai-compatible-endpoint',
      key_secret: 'openai-compatible-key',
    })
    expect(store.get('openai-compatible-key')).toBe('fake-custom-key-000')
    const client = buildLlmClient(config, store)
    expect(Reflect.get(client, 'baseUrl')).toBe('https://llm.example.test/v1')
    expect(Reflect.get(client, 'apiKey')).toBe('fake-custom-key-000')
  })

  it('saves a keyless custom endpoint without referencing a stale stored key', () => {
    store.add('openai-compatible-key', 'fake-stale-key')
    persistForemanLlmChoice({
      services,
      choice: 'custom',
      ollamaModel: null,
      preset: null,
      presetKey: '',
      cloudModel: 'local-model',
      baseUrl: 'http://127.0.0.1:1234/v1',
    })
    const config = loadLlmConfig(services.llmConfigPath)
    expect(config.credentials.openai_compatible?.key_secret).toBeUndefined()
    const client = buildLlmClient(config, store)
    expect(Reflect.get(client, 'apiKey')).toBeNull()
  })
})
