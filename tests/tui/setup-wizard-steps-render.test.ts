import React from 'react'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import type Database from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// =============================================================================
// #621 — one render test per setup-wizard step module. Each test mounts the
// real SetupWizard resumed at that step (setup-state `completed`) and drives
// keys through ink-testing-library. Every side-effecting boundary is mocked:
// live model discovery, Ollama / machine probes, doctor, the browser, and the
// install runner — nothing here reaches the network or installs anything.
// All secrets are obvious fakes.
// =============================================================================

const install = vi.hoisted(() => ({
  resolution: null as string | null,
}))

vi.mock('../../src/core/llm/models-discovery.js', async (orig) => {
  const real = await orig<typeof import('../../src/core/llm/models-discovery.js')>()
  return {
    ...real,
    discoverModels: vi.fn(async (provider: string) => [
      { id: `${provider}-fake-large`, label: `${provider}-fake-large` },
      { id: `${provider}-fake-small`, label: `${provider}-fake-small` },
    ]),
  }
})
vi.mock('../../src/core/ollama-detector.js', async (orig) => {
  const real = await orig<typeof import('../../src/core/ollama-detector.js')>()
  return {
    ...real,
    detectOllama: vi.fn(() => ({
      installed: false,
      version: null,
      binaryPath: null,
      serviceReachable: false,
      installedModels: [],
    })),
  }
})
vi.mock('../../src/core/machine-capability.js', async (orig) => {
  const real = await orig<typeof import('../../src/core/machine-capability.js')>()
  return {
    ...real,
    detectMachineCapability: vi.fn(() => ({
      os: 'linux',
      arch: 'x86_64',
      totalRamBytes: 16 * 1024 ** 3,
      freeRamBytes: 8 * 1024 ** 3,
      cpuCount: 8,
      freeDiskBytesHome: 100 * 1024 ** 3,
      gpu: null,
    })),
  }
})
vi.mock('../../src/utils/browser-open.js', () => ({
  openInBrowser: vi.fn(async () => undefined),
}))
vi.mock('../../src/core/doctor.js', async (orig) => {
  const real = await orig<typeof import('../../src/core/doctor.js')>()
  return {
    ...real,
    runDoctor: vi.fn(() => ({
      checks: [{ name: 'fake-check', status: 'ok', message: 'all good' }],
      exitCode: 0,
      summary: { ok: 1, warn: 0, fail: 0 },
    })),
  }
})
vi.mock('../../src/tui/setup-wizard/install-runner.js', () => ({
  runInstallStep: vi.fn(
    async (
      toAdd: string[],
      _toRemove: string[],
      _services: unknown,
      log: (line: string) => void,
      _configs: unknown,
      onFailure?: (f: {
        agentId: string
        agentName: string
        stage: string
        error: string
        manualHint: string
      }) => Promise<string>,
    ) => {
      log('▸ Hermes')
      install.resolution =
        (await onFailure?.({
          agentId: 'hermes',
          agentName: 'Hermes',
          stage: 'install',
          error: 'install command exited with code 7',
          manualHint: 'Run `fake-install` from your shell.',
        })) ?? null
      log('  ✗ skipped by user')
      return {
        registered: toAdd.filter((id) => id !== 'hermes'),
        identityPushed: [],
        identitySkipped: [],
        failed: ['hermes'],
        removed: [],
        mcpRegisterFailed: [],
      }
    },
  ),
}))

import { SetupWizard, type WizardServices } from '../../src/tui/setup-wizard.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { RegistryService } from '../../src/core/registry.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { createInMemoryDb } from '../../src/db/client.js'
import type { Step } from '../../src/tui/setup-state.js'
import { discoverModels } from '../../src/core/llm/models-discovery.js'
import { saveOAuthTokens } from '../../src/core/llm/oauth/token-store.js'

const ENTER = '\r'
const ESC = '\u001B'
const DOWN = '\u001B[B'
const SPACE = ' '

const ALL_BEFORE: Record<Step, Step[]> = {
  welcome: [],
  providers: ['welcome'],
  'foreman-llm': ['welcome', 'providers'],
  agents: ['welcome', 'providers', 'foreman-llm'],
  services: ['welcome', 'providers', 'foreman-llm', 'agents'],
  'chat-primary': ['welcome', 'providers', 'foreman-llm', 'agents', 'services'],
  'required-setup': ['welcome', 'providers', 'foreman-llm', 'agents', 'services', 'chat-primary'],
  install: ['welcome', 'providers', 'foreman-llm', 'agents', 'services', 'chat-primary', 'required-setup'],
  done: ['welcome', 'providers', 'foreman-llm', 'agents', 'services', 'chat-primary', 'required-setup', 'install'],
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let sandbox: string
let savedForemanHome: string | undefined
let sqlite: Database.Database | null = null
let unmount: (() => void) | null = null

beforeAll(() => {
  // setup-state.json is written under FOREMAN_HOME on every step change.
  sandbox = mkdtempSync(join(tmpdir(), 'wizard-steps-'))
  savedForemanHome = process.env.FOREMAN_HOME
  process.env.FOREMAN_HOME = join(sandbox, 'foreman')
})
afterAll(() => {
  if (savedForemanHome === undefined) delete process.env.FOREMAN_HOME
  else process.env.FOREMAN_HOME = savedForemanHome
  rmSync(sandbox, { recursive: true, force: true })
})
beforeEach(() => {
  install.resolution = null
})
afterEach(() => {
  unmount?.()
  unmount = null
  sqlite?.close()
  sqlite = null
})

interface Mounted {
  frame: () => string
  press: (keys: string, waitFor?: string) => Promise<void>
  type: (text: string) => Promise<void>
  until: (text: string) => Promise<void>
  secretStore: SecretStore
  services: WizardServices
  chatPrimarySet: Mock<[string, string], void>
  launchEditor: Mock<[string], Promise<unknown>>
}

async function mount(
  step: Step,
  opts: { secrets?: Record<string, string>; registered?: string[] } = {},
): Promise<Mounted> {
  const handle = createInMemoryDb()
  sqlite = handle.sqlite
  const registry = new RegistryService(handle.db, new EventBus<ForemanEventMap>())
  for (const id of opts.registered ?? []) {
    registry.register({ id, displayName: id, transport: 'stdio', metadata: { registryId: id } })
  }
  const secretStore = new SecretStore(handle.db, Buffer.alloc(32, 7))
  for (const [name, value] of Object.entries(opts.secrets ?? {})) {
    secretStore.add(name, value)
  }
  const dir = mkdtempSync(join(sandbox, 'paths-'))
  const policyPath = join(dir, 'policy.yaml')
  writeFileSync(policyPath, 'rules:\n  - id: a\n  - id: b\n')
  const chatPrimarySet = vi.fn<[string, string], void>()
  const launchEditor = vi.fn<[string], Promise<unknown>>(async () => undefined)
  const services: WizardServices = {
    db: handle.db,
    secretStore,
    registry,
    chatPrimary: { set: chatPrimarySet } as unknown as WizardServices['chatPrimary'],
    policyPath,
    llmConfigPath: join(dir, 'llm.yaml'),
    notifyConfigPath: join(dir, 'notify.yaml'),
    voiceConfigPath: join(dir, 'voice.yaml'),
    launchEditor,
  }
  const inst = render(
    React.createElement(SetupWizard, {
      initialState: { version: 1, completed: ALL_BEFORE[step], startedAt: 1, lastUpdatedAt: 1 },
      services,
    }),
  )
  unmount = () => inst.unmount()
  const frame = (): string => stripAnsi(inst.lastFrame() ?? '')
  const until = async (text: string): Promise<void> => {
    const deadline = Date.now() + 5_000
    while (!frame().includes(text)) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${JSON.stringify(text)}; frame:\n${frame()}`)
      }
      await sleep(10)
    }
  }
  // Every key gets a render tick before the next one: the wizard's handlers
  // read state from the last render, like a human typing.
  const press = async (keys: string, waitFor?: string): Promise<void> => {
    inst.stdin.write(keys)
    await sleep(60)
    if (waitFor) await until(waitFor)
  }
  const type = async (text: string): Promise<void> => {
    for (const ch of text) {
      inst.stdin.write(ch)
      await sleep(5)
    }
    await sleep(60)
  }
  await sleep(60)
  return { frame, press, type, until, secretStore, services, chatPrimarySet, launchEditor }
}

describe('welcome step', () => {
  it('previews the steps and starts on Enter', async () => {
    const w = await mount('welcome')
    await w.until('Welcome to Foreman')
    expect(w.frame()).toContain("We'll wire this up in 5 steps")
    expect(w.frame()).toContain('[Enter] Start setup')
    await w.press(ENTER, 'LLM Providers ▸ pick which to configure')
  })
})

describe('providers step', () => {
  it('stores a pasted key in the encrypted store and summarises it', async () => {
    const w = await mount('providers')
    await w.until('pick which to configure')
    expect(w.frame()).toContain('Google Gemini')
    await w.press(DOWN)
    await w.press(DOWN)
    await w.press(SPACE)
    await w.press(ENTER, 'Value for Google Gemini API key')
    await w.type('fake-gemini-key-000')
    await w.press(ENTER, 'LLM Providers ▸ summary')
    expect(w.frame()).toContain('✓ Saved 1 provider value')
    expect(w.frame()).toContain('gemini-key')
    // Security boundary: the value lands only in the SecretStore, never in
    // a rendered frame.
    expect(w.secretStore.get('gemini-key')).toBe('fake-gemini-key-000')
    expect(w.frame()).not.toContain('fake-gemini-key-000')
  })

  it('asks OAuth-capable providers for key vs subscription first', async () => {
    const w = await mount('providers')
    await w.until('pick which to configure')
    await w.press(SPACE)
    await w.press(ENTER, 'How do you want to authenticate to')
    expect(w.frame()).toContain('Sign in with your Claude subscription instead of')
    await w.press('y', 'Will sign in via subscription')
    expect(w.frame()).toContain('runs `foreman llm login anthropic`')
  })
})

describe("foreman-llm step (Foreman's brain)", () => {
  it('greys out unconfigured cloud rows and lists live models for a configured one', async () => {
    const w = await mount('foreman-llm', { secrets: { 'openai-key': 'sk-fake-openai-000' } })
    await w.until("Foreman's brain ▸ pick an LLM")
    expect(w.frame()).toContain('✗ Anthropic')
    expect(w.frame()).toContain('✓ OpenAI')
    await w.press(ENTER, 'pick a OpenAI model')
    expect(w.frame()).toContain('openai-fake-large')
  })

  it('walks the Ollama-not-installed and preset sub-screens', async () => {
    const w = await mount('foreman-llm')
    await w.until('pick an LLM')
    await w.press(ENTER, 'Ollama not detected on this machine')
    await w.press(ESC, 'pick an LLM')
    await w.press(DOWN)
    await w.press(ENTER, 'OpenAI-compatible ▸ pick a preset')
    await w.press(ENTER, '▸ API key')
    expect(w.frame()).toContain('Paste your')
  })
})

describe('agents step', () => {
  it('walks picker → per-agent config → confirm', async () => {
    const w = await mount('agents', { secrets: { 'openai-key': 'sk-fake-openai-000' } })
    await w.until('Agents ▸ pick which to install')
    expect(w.frame()).toContain('Pre-checked: hermes')
    await w.press(ENTER, 'Hermes (1/4)')
    expect(w.frame()).toContain('Currently selected')
    await w.press(ENTER, 'how to reach OpenAI')
    await w.press(ENTER, 'pick a OpenAI model')
    await w.press(ENTER, 'responsibility note')
    await w.type('Code review')
    await w.press(ENTER, 'Agents ▸ confirm')
    expect(w.frame()).toContain('▸ Will install: hermes')
    expect(w.frame()).toContain('Continue to services? (y/n)')
  })
})

describe('agents step Esc navigation', () => {
  it('Esc on model-pick for a single-variant agent returns to its provider choice', async () => {
    const w = await mount('agents', { secrets: { 'openai-key': 'sk-fake-openai-000' } })
    await w.until('Agents ▸ pick which to install')
    // hermes off, openclaw (single "native" variant on OpenAI) on
    await w.press(SPACE)
    await w.press(DOWN)
    await w.press(SPACE)
    await w.press(ENTER, 'OpenClaw (1/4)')
    await w.press(ENTER, 'pick a OpenAI model')
    // Used to loop: Esc → auto-skipped variant prompt → back to model-pick.
    await w.press(ESC, 'OpenClaw (1/4)')
    expect(w.frame()).toContain('Currently selected')
  })

  it("Esc on a single-provider agent's variant screen returns to the picker, not the previous agent's note", async () => {
    const w = await mount('agents', {
      secrets: { 'openai-key': 'sk-fake-openai-000', 'anthropic-key': 'sk-ant-fake-000' },
    })
    await w.until('Agents ▸ pick which to install')
    // Hermes on Anthropic has one route, so its variant prompt auto-skips.
    await w.press(ENTER, 'Hermes (1/7)')
    await w.press(ENTER, 'pick a Anthropic model')
    await w.press(ENTER, 'Hermes — responsibility note')
    await w.press(ENTER, 'Claude Code (5/7) · how to reach Anthropic')
    await w.press(ESC, 'Agents ▸ pick which to install')
    expect(w.frame()).not.toContain('responsibility note')
  }, 20_000)
})

describe('services step', () => {
  it('prompts per secret, stores values encrypted and summarises', async () => {
    const w = await mount('services')
    await w.until('Services ▸ pick which to configure')
    await w.press(SPACE)
    await w.press(ENTER, 'prompt 1 of 2')
    expect(w.frame()).toContain('Setting up')
    await w.type('fake-telegram-token-000')
    await w.press(ENTER, 'telegram-chat-id')
    await w.press(ENTER, 'Services ▸ summary')
    expect(w.frame()).toContain('✓ Wired 1 service')
    expect(w.frame()).toContain('⚠ Skipped 1 (empty value)')
    expect(w.secretStore.get('telegram-bot-token')).toBe('fake-telegram-token-000')
    expect(w.frame()).not.toContain('fake-telegram-token-000')
  })
})

describe('chat-primary step', () => {
  it('asks which chat agent owns a shared channel and saves the pick', async () => {
    const w = await mount('services', { registered: ['hermes', 'openclaw'] })
    await w.until('Services ▸ pick which to configure')
    await w.press(SPACE)
    await w.press(ENTER, 'prompt 1 of 2')
    await w.press(ENTER, 'prompt 2 of 2')
    await w.press(ENTER, 'Services ▸ summary')
    await w.press('y', 'Primary Telegram agent')
    expect(w.frame()).toContain('Hermes')
    expect(w.frame()).toContain('OpenClaw')
    await w.press(DOWN)
    await w.press(ENTER, 'Required setup')
    expect(w.chatPrimarySet).toHaveBeenCalledWith('telegram', 'openclaw')
  })
})

describe('required-setup step', () => {
  it('lists missing secrets and stores a pasted one masked', async () => {
    // Per-agent provider picks live in session state only, so reach the
    // step through the agents step: Hermes on OpenAI defaults to the
    // OpenRouter route, which needs an openrouter-key nobody has pasted.
    const w = await mount('agents', { secrets: { 'openai-key': 'sk-fake-openai-000' } })
    await w.until('Agents ▸ pick which to install')
    await w.press(ENTER, 'Hermes (1/4)')
    await w.press(ENTER, 'how to reach OpenAI')
    await w.press(ENTER, 'pick a OpenAI model')
    await w.press(ENTER, 'responsibility note')
    await w.press(ENTER, 'Agents ▸ confirm')
    await w.press('y', 'Services ▸ pick which to configure')
    await w.press(ENTER, 'Services ▸ summary')
    await w.press('y', 'Required setup ▸ missing keys')
    expect(w.frame()).toContain('openrouter-key')
    expect(w.frame()).toContain('status: missing')
    await w.press(DOWN)
    await w.press(ENTER, 'paste openrouter-key')
    await w.type('sk-or-fake-000')
    expect(w.frame()).toContain('•'.repeat('sk-or-fake-000'.length))
    expect(w.frame()).not.toContain('sk-or-fake-000')
    await w.press(ENTER, 'Required setup ▸ all set')
    expect(w.frame()).toContain('status: saved-in-session')
    expect(w.secretStore.get('openrouter-key')).toBe('sk-or-fake-000')
  })
})

describe('install step', () => {
  it('shows the failure prompt, the manual-fix overlay, and resolves skip', async () => {
    const w = await mount('install')
    await w.until('Install + configure')
    expect(w.frame()).toContain('Selected agents: hermes, claude-code')
    await w.until('✗ Hermes — install failed')
    expect(w.frame()).toContain('[r] retry · [s] skip this agent · [m] manual fix instructions')
    await w.press('m', 'Manual fix — Hermes')
    expect(w.frame()).toContain('Run `fake-install` from your shell.')
    await w.press(ESC, '[r] retry')
    await w.press('s', 'Setup complete')
    expect(install.resolution).toBe('skip')
  })
})

describe('foreman-llm step with a subscription sign-in (#575 follow-up)', () => {
  it('acts on the row it draws and explains the pending sign-in', async () => {
    const w = await mount('providers')
    await w.until('pick which to configure')
    await w.press(SPACE)
    await w.press(ENTER, 'How do you want to authenticate to')
    await w.press('y', 'Will sign in via subscription')
    await w.press('y', "Foreman's brain ▸ pick an LLM")
    expect(w.frame()).toContain('❯ ✓ Anthropic')
    await w.press(ENTER, 'Anthropic ▸ default model')
    // Used to open the Ollama screen (the key handler ignored sign-ins) or
    // say "No anthropic-key in the secret store".
    expect(w.frame()).not.toContain('Ollama not detected')
    expect(w.frame()).not.toContain('No anthropic-key')
    expect(w.frame()).toContain('foreman llm login anthropic')
    await w.press(ENTER, 'Agents ▸ pick which to install')
    const llmYaml = readFileSync(w.services.llmConfigPath, 'utf-8')
    expect(llmYaml).toContain('provider: anthropic')
    expect(llmYaml).toMatch(/anthropic:\n\s+auth_mode: oauth/)
  })

  it('lists models with stored Claude sign-in tokens', async () => {
    const w = await mount('foreman-llm')
    saveOAuthTokens(w.secretStore, 'anthropic', {
      accessToken: 'fake-oauth-access-token',
      refreshToken: 'fake-oauth-refresh-token',
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    })
    // Move off and back so the picker re-renders with the new token slot.
    await w.press(DOWN)
    await w.press('\u001B[A')
    await w.until('❯ ✓ Anthropic')
    await w.press(ENTER, 'pick a Anthropic model')
    expect(w.frame()).toContain('anthropic-fake-large')
    expect(vi.mocked(discoverModels)).toHaveBeenLastCalledWith('anthropic', {
      apiKey: 'fake-oauth-access-token',
      auth: 'oauth',
    })
  })
})

describe('done step', () => {
  it('summarises setup and serves the doctor / log / policy hotkeys', async () => {
    const w = await mount('done')
    await w.until('Setup complete — Foreman is ready to guard your agents.')
    expect(w.frame()).toContain('2 policy rules')
    expect(w.frame()).toContain('What next?')
    await w.press('d', 'foreman doctor')
    expect(w.frame()).toContain('fake-check')
    await w.press(ESC, 'What next?')
    await w.press('l', 'Install log')
    await w.press('b', 'What next?')
    await w.press('p')
    expect(w.launchEditor).toHaveBeenCalledWith(w.services.policyPath)
  })
})
