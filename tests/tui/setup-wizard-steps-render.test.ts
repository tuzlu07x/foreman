import React from 'react'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  /** When set, the runner waits for it before doing anything ("running"). */
  hold: null as Promise<void> | null,
  /** When true, the runner throws (a crashed installer). */
  reject: false,
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
      if (install.hold) await install.hold
      if (install.reject) throw new Error('fake installer crashed')
      // Hermes' install "fails" so the failure prompt can be driven.
      if (toAdd.includes('hermes')) {
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
      }
      // #646 — OpenClaw is held back by its Node range.
      const nodeEngineSkipped = toAdd.includes('openclaw')
        ? [
            {
              agentId: 'openclaw',
              lines: [
                'OpenClaw needs Node >=24.16.0 <25 || >=26.1.0',
                'Or run: curl -fsSL https://openclaw.ai/install.sh | bash',
              ],
            },
          ]
        : []
      return {
        registered: toAdd.filter((id) => id !== 'hermes' && id !== 'openclaw'),
        identityPushed: [],
        identitySkipped: [],
        // generic-mcp has no identity file (mirrors runInstallStep).
        identityNotApplicable: toAdd.filter((id) => id === 'generic-mcp'),
        failed: toAdd.filter((id) => id === 'hermes' || id === 'openclaw'),
        removed: [],
        mcpRegisterFailed: [],
        nodeEngineSkipped,
        // generic-mcp has no MCP config to write its token to.
        tokenToWire: toAdd.filter((id) => id === 'generic-mcp'),
      }
    },
  ),
}))

import { SetupWizard, type WizardServices } from '../../src/tui/setup-wizard.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { RegistryService } from '../../src/core/registry.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { createInMemoryDb } from '../../src/db/client.js'
import {
  getSetupStatePath,
  loadSetupState,
  type SetupState,
  type Step,
} from '../../src/tui/setup-state.js'
import { runInstallStep } from '../../src/tui/setup-wizard/install-runner.js'
import { discoverModels } from '../../src/core/llm/models-discovery.js'
import { saveOAuthTokens } from '../../src/core/llm/oauth/token-store.js'
import { createIntegrationWiring, loadIntegrationCatalogs } from '../../src/core/integrations/wiring.js'
import { loadHubConfig } from '../../src/core/mcp-hub/config.js'
import { loadNotifyConfig } from '../../src/core/notification/notify-config.js'
import { buildChannel } from '../../src/core/notification/channel-factory.js'

const integrationCatalogs = loadIntegrationCatalogs()

const ENTER = '\r'
const ESC = '\u001B'
const DOWN = '\u001B[B'
const SPACE = ' '
const BACKSPACE = '\u007F'

// Obvious fakes in the shapes the Services step's paste checks accept.
const FAKE_TELEGRAM_TOKEN = '123456789:AAHfake_telegram_token_0000000000000'
const FAKE_SLACK_TOKEN = 'xoxb-000-fake-slack-token'
const FAKE_DISCORD_TOKEN = `${'F'.repeat(24)}.fake00.${'F'.repeat(27)}`
// A Discord application's public key (64 hex chars), not a bot token.
const FAKE_DISCORD_PUBLIC_KEY = 'f'.repeat(64)

const ALL_BEFORE: Record<Step, Step[]> = {
  welcome: [],
  providers: ['welcome'],
  'foreman-llm': ['welcome', 'providers'],
  agents: ['welcome', 'providers', 'foreman-llm'],
  services: ['welcome', 'providers', 'foreman-llm', 'agents'],
  integrations: ['welcome', 'providers', 'foreman-llm', 'agents', 'services'],
  'chat-primary': ['welcome', 'providers', 'foreman-llm', 'agents', 'services', 'integrations'],
  'required-setup': ['welcome', 'providers', 'foreman-llm', 'agents', 'services', 'integrations', 'chat-primary'],
  install: ['welcome', 'providers', 'foreman-llm', 'agents', 'services', 'integrations', 'chat-primary', 'required-setup'],
  done: [
    'welcome',
    'providers',
    'foreman-llm',
    'agents',
    'services',
    'integrations',
    'chat-primary',
    'required-setup',
    'install',
  ],
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Matches `text` even where the frame wrapped it across lines. */
const loose = (text: string): RegExp => new RegExp(text.split(' ').map(escapeRegExp).join('\\s+'))
/** Polls a mock assertion (onQuit, launchEditor): a key's effect is never
 *  assumed to have landed after a fixed sleep. */
const eventually = (check: () => void): Promise<void> => vi.waitFor(check, { timeout: 5_000, interval: 10 })

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
  install.hold = null
  install.reject = false
})
afterEach(() => {
  unmount?.()
  unmount = null
  sqlite?.close()
  sqlite = null
})

interface Mounted {
  frame: () => string
  press: (keys: string, waitFor?: string | RegExp) => Promise<void>
  /** ↑ / ↓ / Space in a list: returns once the cursor row shows it. */
  pressInList: (key: string) => Promise<void>
  /** Enter, one rendered screen at a time, until `text` shows. */
  enterUntil: (text: string) => Promise<void>
  type: (text: string) => Promise<void>
  /** Backspace `count` times in the focused field. */
  erase: (count: number) => Promise<void>
  until: (target: string | RegExp) => Promise<void>
  secretStore: SecretStore
  services: WizardServices
  /** The temp mcp.yaml the Integrations step writes. */
  mcpConfigPath: string
  /** Audit events the Integrations step logged. */
  auditEvents: { type: string; payload: unknown }[]
  chatPrimarySet: Mock<(a: string, b: string) => void>
  launchEditor: Mock<(path: string) => Promise<unknown>>
  onQuit: Mock<() => void>
  /** A run resumed at install re-opens required-setup (never auto-starts):
   *  wait for "Ready to install" and press [c]. */
  startInstall: () => Promise<void>
}

async function mount(
  step: Step,
  opts: {
    secrets?: Record<string, string>
    registered?: string[]
    /** Registered agents Foreman installed itself (#657). */
    installedByForeman?: string[]
    /** Resume from this state instead of "every step before `step`". */
    initialState?: SetupState
    afterExit?: 'exit' | 'launch-tui'
    /** false = no integration wiring (the catalog failed to load). */
    integrations?: false
  } = {},
): Promise<Mounted> {
  const handle = createInMemoryDb()
  sqlite = handle.sqlite
  const registry = new RegistryService(handle.db, new EventBus<ForemanEventMap>())
  for (const id of opts.registered ?? []) {
    const installed = opts.installedByForeman?.includes(id)
      ? { installedByForeman: { command: `npm install -g ${id}`, at: 1 } }
      : {}
    registry.register({ id, displayName: id, transport: 'stdio', metadata: { registryId: id, ...installed } })
  }
  const secretStore = new SecretStore(handle.db, Buffer.alloc(32, 7))
  for (const [name, value] of Object.entries(opts.secrets ?? {})) {
    secretStore.add(name, value)
  }
  const dir = mkdtempSync(join(sandbox, 'paths-'))
  const policyPath = join(dir, 'policy.yaml')
  writeFileSync(policyPath, 'rules:\n  - id: a\n  - id: b\n')
  const chatPrimarySet = vi.fn<(a: string, b: string) => void>()
  const launchEditor = vi.fn<(path: string) => Promise<unknown>>(async () => undefined)
  const mcpConfigPath = join(dir, 'mcp.yaml')
  const auditEvents: { type: string; payload: unknown }[] = []
  const integrations =
    opts.integrations === false
      ? undefined
      : createIntegrationWiring({
          paths: { mcpConfigPath, mcpPinsPath: join(dir, 'mcp-pins.json') },
          store: secretStore,
          audit: { logEvent: (type, payload) => auditEvents.push({ type, payload }) },
          catalogs: integrationCatalogs,
        })
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
    ...(integrations ? { integrations } : {}),
  }
  const onQuit = vi.fn<() => void>()
  const wizard = React.createElement(SetupWizard, {
    initialState: opts.initialState ?? {
      version: 1,
      completed: ALL_BEFORE[step],
      startedAt: 1,
      lastUpdatedAt: 1,
    },
    services,
    ...(opts.afterExit ? { afterExit: opts.afterExit } : {}),
    onQuit,
  })
  const inst = render(wizard)
  unmount = () => inst.unmount()
  const frame = (): string => stripAnsi(inst.lastFrame() ?? '')
  const waitFrame = async (done: (f: string) => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 5_000
    while (!done(frame())) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}; frame:\n${frame()}`)
      }
      await sleep(10)
    }
  }
  const until = (target: string | RegExp): Promise<void> =>
    typeof target === 'string'
      ? waitFrame((f) => f.includes(target), JSON.stringify(target))
      : waitFrame((f) => target.test(f), String(target))
  // A key's effect can land after any fixed sleep (Esc is dispatched on a
  // timer, effects re-render later, a loaded machine is slow), so every key
  // that another key or an assertion depends on waits for what it draws:
  // the wizard's handlers act on the screen as last rendered, like a human.
  const press = async (keys: string, waitFor?: string | RegExp): Promise<void> => {
    inst.stdin.write(keys)
    await sleep(60)
    if (waitFor) await until(waitFor)
  }
  // The list row under the cursor: required-setup and the brain picker draw
  // ❯; @inkjs/ui's Select / MultiSelect draw figures.pointer, `>` here.
  const cursorRow = (f: string): string => f.split('\n').find((l) => /^\s*[❯>] \S/.test(l)) ?? ''
  const pressInList = async (key: string): Promise<void> => {
    const before = cursorRow(frame())
    inst.stdin.write(key)
    await waitFrame((f) => cursorRow(f) !== before, `the cursor row to change from ${JSON.stringify(before)}`)
  }
  const enterUntil = async (text: string): Promise<void> => {
    for (let i = 0; i < 10 && !frame().includes(text); i++) {
      const before = frame()
      inst.stdin.write(ENTER)
      await waitFrame((f) => f !== before, `a new screen on the way to ${JSON.stringify(text)}`)
    }
    await until(text)
  }
  const type = async (text: string): Promise<void> => {
    // The field's input handler subscribes in an effect that runs after
    // the frame showing it; on a loaded machine a key sent the moment the
    // frame appears was lost (8 of 9 characters, full-suite QA run).
    await sleep(100)
    for (const ch of text) {
      inst.stdin.write(ch)
      await sleep(5)
    }
    // The field shows it as typed, or masked (required-setup's •, PasswordInput's *).
    const shown = [text, '•'.repeat(Math.min(text.length, 32)), '*'.repeat(text.length)]
    await until(new RegExp(shown.map(escapeRegExp).join('|')))
  }
  const erase = async (count: number): Promise<void> => {
    await sleep(100)
    for (let i = 0; i < count; i++) {
      inst.stdin.write(BACKSPACE)
      await sleep(5)
    }
    await sleep(60)
  }
  await sleep(60)
  const startInstall = async (): Promise<void> => {
    await until('Ready to install')
    await press('c')
    // A fast (mocked) install can go straight on to Done.
    const deadline = Date.now() + 5_000
    while (!/Install \+ configure|Setup complete/.test(frame())) {
      if (Date.now() > deadline) {
        throw new Error(`install did not start; frame:\n${frame()}`)
      }
      await sleep(10)
    }
  }
  return {
    frame,
    press,
    pressInList,
    enterUntil,
    type,
    erase,
    until,
    secretStore,
    services,
    mcpConfigPath,
    auditEvents,
    chatPrimarySet,
    launchEditor,
    onQuit,
    startInstall,
  }
}

const CTRL_C = '\u0003'

describe('Ctrl-C and modified hotkeys', () => {
  it('Ctrl-C quits from the Welcome screen', async () => {
    const w = await mount('welcome')
    await w.until('Welcome to Foreman')
    await w.until('Quit any time with Ctrl-C (except while agents are installing)')
    await w.press(CTRL_C)
    await eventually(() => expect(w.onQuit).toHaveBeenCalledTimes(1))
  })

  it('Ctrl-C quits from a picker screen', async () => {
    const w = await mount('providers')
    await w.until('pick which to configure')
    await w.press(CTRL_C)
    await eventually(() => expect(w.onQuit).toHaveBeenCalledTimes(1))
  })

  it('Ctrl-C at "ready to install" quits instead of starting the install', async () => {
    const before = vi.mocked(runInstallStep).mock.calls.length
    const w = await mount('required-setup')
    await w.until('Ready to install')
    // Ctrl-C reaches the handlers as input "c" + ctrl — this screen's
    // "[c] continue" used to start the install.
    await w.press(CTRL_C)
    await eventually(() => expect(w.onQuit).toHaveBeenCalledTimes(1))
    expect(vi.mocked(runInstallStep).mock.calls.length - before).toBe(0)
  })

  it('Meta+letter never fires a single-letter hotkey', async () => {
    const before = vi.mocked(runInstallStep).mock.calls.length
    const w = await mount('required-setup')
    await w.until('Ready to install')
    await w.press('\u001Bc')
    await w.until('Required setup')
    expect(vi.mocked(runInstallStep).mock.calls.length - before).toBe(0)
    expect(w.onQuit).not.toHaveBeenCalled()
  })

  it('Ctrl-C while the installer runs shows a notice, then quits once it is done', async () => {
    const before = vi.mocked(runInstallStep).mock.calls.length
    let release: () => void = () => undefined
    install.hold = new Promise<void>((r) => {
      release = r
    })
    const w = await mount('install')
    await w.startInstall()
    await w.press(CTRL_C, 'Install in progress — Ctrl-C again after it finishes')
    expect(w.onQuit).not.toHaveBeenCalled()
    release()
    await w.until('✗ Hermes — install failed')
    // Paused on a failure prompt: the notice says what unblocks it.
    await w.press(CTRL_C, 'Install paused on a failure — press [r] retry or [s] skip')
    expect(w.onQuit).not.toHaveBeenCalled()
    expect(install.resolution).toBeNull()
    await w.press('s', 'Setup complete')
    await w.press(CTRL_C)
    await eventually(() => expect(w.onQuit).toHaveBeenCalledTimes(1))
    expect(vi.mocked(runInstallStep).mock.calls.length - before).toBe(1)
  })

  it('a crashed installer records a failed summary and moves on to Done', async () => {
    install.reject = true
    const w = await mount('install')
    await w.startInstall()
    // Used to stay on the install screen forever (Ctrl-C refused too).
    await w.until('Setup complete')
    await w.press('l', 'Install log')
    await w.until('✗ install step failed: fake installer crashed')
    await w.press('b', 'What next?')
    await w.press(CTRL_C)
    await eventually(() => expect(w.onQuit).toHaveBeenCalledTimes(1))
  })
})

describe('welcome step', () => {
  it('previews the steps and starts on Enter', async () => {
    const w = await mount('welcome')
    await w.until('Welcome to Foreman')
    await w.until("We'll wire this up in 6 steps")
    await w.until('[Enter] Start setup')
    await w.press(ENTER, 'LLM Providers ▸ pick which to configure')
  })

  // QA #657 L3 — below 120 columns the mascot squeezed the text past the
  // edge and the screen outgrew 24 rows (its top then stayed on screen
  // under the next step); the copy said a Telegram bot is needed.
  it('fits a 100-column, 24-row terminal and says chat apps are optional', async () => {
    const w = await mount('welcome')
    await w.until('Welcome to Foreman')
    const lines = w.frame().split('\n')
    expect(lines.length).toBeLessThanOrEqual(24)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(100)
    expect(w.frame()).not.toContain('▄▄▄▄')
    expect(w.frame()).not.toContain('Telegram bot you control')
    expect(w.frame().replace(/\s+/g, ' ')).toContain('Chat apps like Telegram are optional')
    expect(w.frame()).not.toContain('…')
  })
})

describe('step numbering', () => {
  it.each([
    ['providers', 'Step 1 of 6 ▸ LLM Providers'],
    ['foreman-llm', "Step 2 of 6 ▸ Foreman's brain"],
    ['agents', 'Step 3 of 6 ▸ Agents'],
    ['services', 'Step 4 of 6 ▸ Services'],
    ['integrations', 'Step 5 of 6 ▸ Integrations'],
    ['required-setup', 'Step 6 of 6 ▸ Required setup'],
    ['install', 'Step 6 of 6 ▸ Install + configure'],
  ] as const)('%s shows "%s"', async (step, header) => {
    const w = await mount(step)
    if (step === 'install') await w.startInstall()
    await w.until(header)
  })
})

describe('providers step', () => {
  it('stores a pasted key in the encrypted store and summarises it', async () => {
    const w = await mount('providers')
    await w.until('pick which to configure')
    await w.until('Google Gemini')
    await w.pressInList(DOWN)
    await w.pressInList(DOWN)
    await w.pressInList(SPACE)
    await w.press(ENTER, 'Value for Google Gemini API key')
    await w.type('fake-gemini-key-000')
    await w.press(ENTER, 'LLM Providers ▸ summary')
    await w.until('✓ Saved 1 provider value')
    await w.until('gemini-key')
    // Security boundary: the value lands only in the SecretStore, never in
    // a rendered frame.
    expect(w.secretStore.get('gemini-key')).toBe('fake-gemini-key-000')
    expect(w.frame()).not.toContain('fake-gemini-key-000')
  })

  // QA #657 L7 — `not a url` was taken as an endpoint without a word.
  it('warns (and still saves) when an endpoint is not a URL', async () => {
    const w = await mount('providers')
    await w.until('pick which to configure')
    await w.pressInList(DOWN)
    await w.pressInList(DOWN)
    await w.pressInList(DOWN)
    await w.pressInList(SPACE)
    await w.press(ENTER)
    await w.until('Local (Ollama)')
    // The field starts with the default endpoint; this makes it invalid.
    await w.type('not a url')
    await w.press(ENTER, 'LLM Providers ▸ summary')
    expect(w.frame().replace(/\s+/g, ' ')).toContain("not a url\" doesn't look like an http(s) URL")
    expect(w.secretStore.get('ollama-endpoint')).toMatch(/not a url$/)
  })

  it('asks OAuth-capable providers for key vs subscription first', async () => {
    const w = await mount('providers')
    await w.until('pick which to configure')
    await w.pressInList(SPACE)
    await w.press(ENTER, 'How do you want to connect')
    await w.until('API key — paste it on the next screen')
    await w.until('Claude subscription — sign in in the browser after setup')
    await w.press(DOWN)
    await w.press(ENTER, 'Will sign in with your subscription')
    await w.until('runs `foreman llm login anthropic`')
  })

  // Real-services test (2.2.0): the question was a y/n whose Enter meant
  // "subscription", so a key pasted there was dropped and a browser sign-in
  // queued. Enter now takes the highlighted choice, an API key.
  it('takes a key by default: Enter on the question leads to the key prompt, never a sign-in', async () => {
    const w = await mount('providers')
    await w.until('pick which to configure')
    await w.pressInList(SPACE)
    await w.press(ENTER, 'How do you want to connect')
    await w.press(ENTER, 'Value for Anthropic')
    await w.type('sk-ant-fake-key-000')
    await w.press(ENTER, 'LLM Providers ▸ summary')
    await w.until('anthropic-key')
    expect(w.frame()).not.toContain('Will sign in with your subscription')
    expect(w.secretStore.get('anthropic-key')).toBe('sk-ant-fake-key-000')
  })

  it('n on the summary goes back to the picker and asks the question again', async () => {
    const w = await mount('providers')
    await w.until('pick which to configure')
    await w.pressInList(SPACE)
    await w.press(ENTER, 'How do you want to connect')
    await w.press(DOWN)
    await w.press(ENTER, 'Will sign in with your subscription')
    // The confirm prompt subscribes to keys in an effect after the frame
    // that shows it: a key sent at once was lost on a loaded machine.
    await sleep(150)
    await w.press('n', 'pick which to configure')
    // The earlier answer is gone: picking again asks again.
    await w.press(ENTER, 'How do you want to connect')
  })
})

describe("foreman-llm step (Foreman's brain)", () => {
  it('greys out unconfigured cloud rows and lists live models for a configured one', async () => {
    const w = await mount('foreman-llm', { secrets: { 'openai-key': 'sk-fake-openai-000' } })
    await w.until("Foreman's brain ▸ pick an LLM")
    await w.until('✗ Anthropic')
    // Why it can't be picked, on the row itself (the cursor never lands there).
    await w.until('needs an Anthropic key or Claude sign-in in Step 1')
    await w.until('✓ OpenAI')
    await w.press(ENTER, 'pick a OpenAI model')
    await w.until('openai-fake-large')
  })

  it('offers Ollama: base URL (local default), then the pulled models', async () => {
    const w = await mount('foreman-llm')
    await w.until('pick an LLM')
    // With no cloud provider configured, the cursor starts on Ollama.
    await w.until('❯ ✓ Local — Ollama')
    await w.until('✓ Custom — OpenAI-compatible')
    expect(w.frame()).not.toContain('not supported yet')
    await w.press(ENTER, 'Ollama ▸ base URL')
    await w.until('http://localhost:11434')
    await w.press(ENTER, 'Ollama ▸ pick a model')
    await w.until('❯ ✓ ollama-fake-large')
    expect(vi.mocked(discoverModels)).toHaveBeenLastCalledWith(
      'ollama',
      expect.objectContaining({ apiKey: '', baseUrl: 'http://localhost:11434' }),
    )
    await w.pressInList(DOWN)
    await w.press(ENTER, 'Agents ▸ pick which to install')
    const llmYaml = readFileSync(w.services.llmConfigPath, 'utf-8')
    expect(llmYaml).toContain('provider: ollama')
    expect(llmYaml).toContain('model: ollama-fake-small')
    expect(llmYaml).toContain('endpoint: http://localhost:11434')
  })

  it('keeps the user on the URL screen when the base URL is invalid', async () => {
    const w = await mount('foreman-llm')
    await w.until('❯ ✓ Local — Ollama')
    await w.press(ENTER, 'Ollama ▸ base URL')
    const callsBefore = vi.mocked(discoverModels).mock.calls.length
    // The field starts with the default URL; this makes it invalid.
    await w.type(' not a url')
    await w.press(ENTER, 'Not a usable base URL: it is not a valid URL.')
    expect(w.frame()).toContain('Ollama ▸ base URL')
    expect(vi.mocked(discoverModels).mock.calls.length).toBe(callsBefore)
  })

  it('offers an own OpenAI-compatible endpoint: URL, optional key, model', async () => {
    const w = await mount('foreman-llm')
    await w.until('❯ ✓ Local — Ollama')
    await w.pressInList(DOWN)
    await w.press(ENTER, 'OpenAI-compatible ▸ pick a preset')
    // Up from the first preset wraps to the last row: your own endpoint.
    await w.press('\u001B[A', '❯ ✓ Other endpoint')
    await w.press(ENTER, 'Own endpoint ▸ base URL')
    await w.type('http://127.0.0.1:8000/v1/')
    await w.press(ENTER, 'Own endpoint ▸ API key')
    await w.press(ENTER, 'Own endpoint ▸ pick a model')
    await w.until('❯ ✓ openai_compatible-fake-large')
    expect(vi.mocked(discoverModels)).toHaveBeenLastCalledWith(
      'openai_compatible',
      expect.objectContaining({ apiKey: '', baseUrl: 'http://127.0.0.1:8000/v1' }),
    )
    await w.press(ENTER, 'Agents ▸ pick which to install')
    const llmYaml = readFileSync(w.services.llmConfigPath, 'utf-8')
    expect(llmYaml).toContain('provider: openai_compatible')
    expect(llmYaml).toContain('model: openai_compatible-fake-large')
    expect(llmYaml).toContain('endpoint_secret: openai-compatible-endpoint')
    // Keyless: no key slot is referenced, and none was stored.
    expect(llmYaml).not.toContain('key_secret')
    expect(w.secretStore.get('openai-compatible-endpoint')).toBe('http://127.0.0.1:8000/v1')
    expect(w.secretStore.exists('openai-compatible-key')).toBe(false)
  })

  it('lets a preset pick its model from the live list', async () => {
    const w = await mount('foreman-llm')
    await w.until('❯ ✓ Local — Ollama')
    await w.pressInList(DOWN)
    await w.press(ENTER, 'OpenAI-compatible ▸ pick a preset')
    await w.until('❯ ✓ DeepSeek')
    await w.press(ENTER, 'DeepSeek ▸ API key')
    await w.type('fake-deepseek-key-000')
    await w.press(ENTER, 'DeepSeek ▸ pick a model')
    await w.until('❯ ✓ openai_compatible-fake-large')
    expect(w.frame()).not.toContain('fake-deepseek-key-000')
    expect(vi.mocked(discoverModels)).toHaveBeenLastCalledWith(
      'openai_compatible',
      expect.objectContaining({ apiKey: 'fake-deepseek-key-000', baseUrl: 'https://api.deepseek.com/v1' }),
    )
    await w.press(ENTER, 'Agents ▸ pick which to install')
    const llmYaml = readFileSync(w.services.llmConfigPath, 'utf-8')
    expect(llmYaml).toContain('model: openai_compatible-fake-large')
    expect(llmYaml).toContain('key_secret: deepseek-api-key')
    expect(w.secretStore.get('deepseek-api-key')).toBe('fake-deepseek-key-000')
  })

  it('still lets the user skip the brain', async () => {
    const w = await mount('foreman-llm')
    await w.until('❯ ✓ Local — Ollama')
    await w.pressInList(DOWN)
    await w.press(DOWN, '❯ ✓ Skip — heuristics only')
    await w.press(ENTER, 'Agents ▸ pick which to install')
    expect(readFileSync(w.services.llmConfigPath, 'utf-8')).toContain('enabled: false')
  })
})

describe('agents step', () => {
  it('walks picker → per-agent config → confirm', async () => {
    const w = await mount('agents', { secrets: { 'openai-key': 'sk-fake-openai-000' } })
    await w.until('Agents ▸ pick which to install')
    await w.until('Checked: hermes')
    await w.press(ENTER, 'Hermes (1/4)')
    await w.until('Currently selected')
    await w.press(ENTER, 'how to reach OpenAI')
    await w.press(ENTER, 'pick a OpenAI model')
    await w.press(ENTER, 'responsibility note')
    await w.type('Code review')
    await w.press(ENTER, 'Agents ▸ confirm')
    await w.until('▸ Will install: hermes')
    await w.until('Continue to services? (y/n)')
  })
})

// QA #657 H5 — unticking an agent uninstalled its binary. The confirm
// screen now says it is only unregistered; uninstalling what Foreman
// installed is an explicit `u`.
describe('agents confirm: removing keeps binaries unless asked', () => {
  const untickCodexTickGeneric = async (w: Mounted): Promise<void> => {
    await w.until('Checked: codex')
    await w.pressInList(DOWN)
    await w.pressInList(DOWN)
    await w.press(SPACE, 'Checked: (none)')
    await w.pressInList(DOWN)
    await w.pressInList(DOWN)
    await w.press(SPACE, 'Checked: generic-mcp')
    await w.enterUntil('Agents ▸ confirm')
  }

  it('says unticked agents stay installed, and offers no uninstall Foreman may not do', async () => {
    const w = await mount('agents', { secrets: { 'openai-key': 'sk-fake-openai-000' }, registered: ['codex'] })
    await untickCodexTickGeneric(w)
    await w.until('▸ Will unregister: codex (binaries stay installed)')
    expect(w.frame()).not.toContain('also uninstall')
  })

  it('u toggles uninstalling an agent Foreman installed, and the choice reaches the installer', async () => {
    const w = await mount('agents', {
      secrets: { 'openai-key': 'sk-fake-openai-000' },
      registered: ['codex'],
      installedByForeman: ['codex'],
    })
    await untickCodexTickGeneric(w)
    await w.until('☐ also uninstall what Foreman')
    await w.press('u', '☑')
    await w.until('▸ Will unregister: codex · and uninstall codex')
    await w.press('u', '☐')
    await w.press('u', '☑')
    const before = vi.mocked(runInstallStep).mock.calls.length
    await w.press('y', 'Services ▸ pick which to configure')
    await w.press(ENTER, 'Services ▸ summary')
    await w.press('y', 'Integrations ▸ optional')
    await w.press(ENTER)
    await w.startInstall()
    const call = vi.mocked(runInstallStep).mock.calls[before]
    expect(call?.[1]).toEqual(['codex'])
    expect(call?.[7]).toEqual({ uninstall: true })
  })
})

describe('agents picker header', () => {
  it('follows what is currently checked, and keeps it when you come back', async () => {
    const w = await mount('agents', { secrets: { 'openai-key': 'sk-fake-openai-000' } })
    await w.until('Checked: hermes')
    // Untick Hermes: the header used to keep saying "Pre-checked: hermes".
    await w.press(SPACE, 'Checked: (none)')
    await w.pressInList(DOWN)
    await w.press(SPACE, 'Checked: openclaw')
    // The toggles themselves survive the re-render (check glyph varies: ✔ / √).
    await w.until(/OpenClaw — Multi-channel assistant with a lobster-themed TUI [✔√]/)
    expect(w.frame()).not.toMatch(/Hermes — Personal AI assistant on Telegram and Discord [✔√]/)
    // QA #657 M11 — Esc back to the picker used to re-tick the defaults
    // (and Enter then installed Hermes). It keeps your pick now.
    await w.press(ENTER, 'OpenClaw (1/4)')
    await w.press(ESC, 'Agents ▸ pick which to install')
    await w.until('Checked: openclaw')
    await w.until(/OpenClaw — Multi-channel assistant with a lobster-themed TUI [✔√]/)
    expect(w.frame()).not.toMatch(/Hermes — Personal AI assistant on Telegram and Discord [✔√]/)
  })

  it('keeps the responsibility note you typed when you come back to it', async () => {
    const w = await mount('agents', { secrets: { 'openai-key': 'sk-fake-openai-000' } })
    await w.press(ENTER, 'Hermes (1/4)')
    await w.press(ENTER, 'how to reach OpenAI')
    await w.press(ENTER, 'pick a OpenAI model')
    await w.press(ENTER, 'responsibility note')
    await w.type('Nightly diff triage')
    await w.press(ENTER, 'Agents ▸ confirm')
    await w.press(ESC, 'Agents ▸ pick which to install')
    await w.press(ENTER, 'Hermes (1/4)')
    await w.press(ENTER, 'how to reach OpenAI')
    await w.press(ENTER, 'pick a OpenAI model')
    await w.press(ENTER, 'responsibility note')
    await w.until('Nightly diff triage')
  })

  it('keeps your pick after Esc from the confirm screen', async () => {
    const w = await mount('agents', { secrets: { 'openai-key': 'sk-fake-openai-000' } })
    await w.until('Checked: hermes')
    await w.press(SPACE, 'Checked: (none)')
    await w.pressInList(DOWN)
    await w.pressInList(DOWN)
    await w.pressInList(DOWN)
    await w.pressInList(DOWN)
    await w.press(SPACE, 'Checked: generic-mcp')
    await w.enterUntil('Agents ▸ confirm')
    await w.until('▸ Will install: generic-mcp')
    await w.press(ESC, 'Agents ▸ pick which to install')
    await w.until('Checked: generic-mcp')
    await w.enterUntil('Agents ▸ confirm')
    await w.until('▸ Will install: generic-mcp')
    expect(w.frame()).not.toContain('hermes')
  })
})

describe('agents step Esc navigation', () => {
  it('Esc on model-pick for a single-variant agent returns to its provider choice', async () => {
    const w = await mount('agents', { secrets: { 'openai-key': 'sk-fake-openai-000' } })
    await w.until('Agents ▸ pick which to install')
    // hermes off, openclaw (single "native" variant on OpenAI) on
    await w.pressInList(SPACE)
    await w.pressInList(DOWN)
    await w.pressInList(SPACE)
    await w.press(ENTER, 'OpenClaw (1/4)')
    await w.press(ENTER, 'pick a OpenAI model')
    // Used to loop: Esc → auto-skipped variant prompt → back to model-pick.
    await w.press(ESC, 'OpenClaw (1/4)')
    await w.until('Currently selected')
  })

  it("asks whether to check Claude Code's own tools, and n moves on to its note", async () => {
    const w = await mount('agents', {
      secrets: { 'openai-key': 'sk-fake-openai-000', 'anthropic-key': 'sk-ant-fake-000' },
    })
    await w.until('Agents ▸ pick which to install')
    await w.press(ENTER, 'Hermes (1/8)')
    await w.press(ENTER, 'pick a Anthropic model')
    await w.press(ENTER, 'Hermes — responsibility note')
    await w.press(ENTER, 'Claude Code (5/8) · how to reach Anthropic')
    await w.enterUntil('Claude Code — its own tools (7/8)')
    expect(w.frame()).toContain("Also check Claude Code's own tools before they run? (recommended)")
    await w.press('n', 'Claude Code — responsibility note (8/8)')
  }, 20_000)

  it("Esc on a single-provider agent's variant screen returns to the picker, not the previous agent's note", async () => {
    const w = await mount('agents', {
      secrets: { 'openai-key': 'sk-fake-openai-000', 'anthropic-key': 'sk-ant-fake-000' },
    })
    await w.until('Agents ▸ pick which to install')
    // Hermes on Anthropic has one route, so its variant prompt auto-skips.
    await w.press(ENTER, 'Hermes (1/8)')
    await w.press(ENTER, 'pick a Anthropic model')
    await w.press(ENTER, 'Hermes — responsibility note')
    await w.press(ENTER, 'Claude Code (5/8) · how to reach Anthropic')
    await w.press(ESC, 'Agents ▸ pick which to install')
    expect(w.frame()).not.toContain('responsibility note')
  }, 20_000)
})

describe('services step', () => {
  it('prompts per secret, stores values encrypted and summarises', async () => {
    const w = await mount('services')
    await w.until('Services ▸ pick which to configure')
    await w.pressInList(SPACE)
    await w.press(ENTER, 'prompt 1 of 2')
    await w.until('Setting up')
    await w.type(FAKE_TELEGRAM_TOKEN)
    await w.press(ENTER, 'telegram-chat-id')
    await w.press(ENTER, 'Services ▸ summary')
    await w.until('✓ Wired 1 service')
    await w.until('⚠ Skipped 1 (empty value)')
    expect(w.secretStore.get('telegram-bot-token')).toBe(FAKE_TELEGRAM_TOKEN)
    expect(w.frame()).not.toContain(FAKE_TELEGRAM_TOKEN)
    // No chat id: Telegram is not turned on half-configured.
    await w.until(loose('telegram (no chat id): foreman notify enable telegram --chat-id <id>'))
    await w.press('y', 'Integrations ▸ optional')
    expect(loadNotifyConfig(w.services.notifyConfigPath).channels.telegram?.enabled).toBe(false)
  })

  // QA #657 L8 — on a resumed setup the services step showed stored
  // services as unconfigured, "(no services configured", while Done then
  // counted them.
  it('shows services already stored as configured, and Enter keeps them', async () => {
    const w = await mount('services', {
      secrets: { 'telegram-bot-token': '123456789:AAHfake_token-abcdefghijklmnopqrstuvwxyz' },
    })
    await w.until('Services ▸ pick which to configure')
    await w.until(/Telegram — .* [✔√]/)
    await w.press(ENTER, 'prompt 1 of 2')
    await w.until('already stored — Enter on empty input keeps it')
    await w.press(ENTER, 'telegram-chat-id')
    await w.press(ENTER, 'Services ▸ summary')
    await w.until('✓ Wired 1 service')
    await w.until('• telegram-bot-token')
    expect(w.frame()).not.toContain('no services configured')
    expect(w.secretStore.get('telegram-bot-token')).toBe('123456789:AAHfake_token-abcdefghijklmnopqrstuvwxyz')
  })

  // QA #657 L7 — `notatoken` was taken as a Telegram token without a word.
  // Real-user test: a Discord public key pasted as the bot token was saved
  // at once; a value with the wrong shape now needs a second Enter.
  it('holds back a token or chat id with the wrong shape until Enter again', async () => {
    const w = await mount('services')
    await w.until('Services ▸ pick which to configure')
    await w.pressInList(SPACE)
    await w.press(ENTER, 'prompt 1 of 2')
    await w.type('notatoken')
    await w.press(ENTER, loose('Press Enter again to save it anyway, or paste the right value'))
    expect(w.frame()).toMatch(loose("doesn't look like a Telegram bot token"))
    expect(w.frame()).toContain('prompt 1 of 2')
    expect(w.secretStore.exists('telegram-bot-token')).toBe(false)
    await w.press(ENTER, 'telegram-chat-id')
    await w.until(loose('Saved anyway — fix it with `foreman secrets rotate telegram-bot-token`'))
    expect(w.secretStore.get('telegram-bot-token')).toBe('notatoken')
    await w.type('my chat')
    await w.press(ENTER, loose("doesn't look like a Telegram chat id"))
    expect(w.secretStore.exists('telegram-chat-id')).toBe(false)
    await w.press(ENTER, 'Services ▸ summary')
    expect(w.secretStore.get('telegram-chat-id')).toBe('my chat')
  })

  it('does not save a Discord public key pasted as the bot token on the first Enter', async () => {
    const w = await mount('services')
    await w.until('Services ▸ pick which to configure')
    await w.pressInList(DOWN)
    await w.pressInList(SPACE)
    await w.press(ENTER, 'prompt 1 of 2')
    await w.type(FAKE_DISCORD_PUBLIC_KEY)
    await w.press(ENTER, loose("doesn't look like a Discord bot token (three dot-separated parts)"))
    await w.until(loose('Press Enter again to save it anyway, or paste the right value'))
    expect(w.frame()).not.toContain('Saved anyway')
    expect(w.secretStore.exists('discord-bot-token')).toBe(false)
    // Empty input still skips — and with no token there is no channel to ask for.
    await w.erase(FAKE_DISCORD_PUBLIC_KEY.length)
    await w.press(ENTER, 'Services ▸ summary')
    await w.until('• discord-bot-token')
    expect(w.secretStore.exists('discord-bot-token')).toBe(false)
    await w.press('y', 'Integrations ▸ optional')
    expect(existsSync(w.services.notifyConfigPath)).toBe(false)
  })

  it('asks for the Slack channel after the bot token and writes it to notify.yaml', async () => {
    const w = await mount('services')
    await w.until('Services ▸ pick which to configure')
    await w.pressInList(DOWN)
    await w.pressInList(DOWN)
    await w.pressInList(SPACE)
    await w.press(ENTER, 'prompt 1 of 2')
    await w.type(FAKE_SLACK_TOKEN)
    await w.press(ENTER, 'Slack — channel')
    await w.until('/invite @yourapp')
    await w.until('#foreman')
    await w.press(ENTER, 'Services ▸ summary')
    expect(w.frame()).not.toContain('Not turned on yet')
    await w.press('y', 'Integrations ▸ optional')
    const slack = loadNotifyConfig(w.services.notifyConfigPath).channels.slack!
    expect(slack).toEqual({ enabled: true, bot_token_ref: 'slack-bot-token', channel: '#foreman' })
    // What `foreman doctor` builds: the channel is complete.
    expect(buildChannel('slack', slack, { secrets: w.secretStore })).not.toHaveProperty('problem')
  })

  it('asks for the Discord channel id, refuses one that is not 17–20 digits', async () => {
    const w = await mount('services')
    await w.until('Services ▸ pick which to configure')
    await w.pressInList(DOWN)
    await w.pressInList(SPACE)
    await w.press(ENTER, 'prompt 1 of 2')
    await w.type(FAKE_DISCORD_TOKEN)
    await w.press(ENTER, 'Discord — channel id')
    await w.until('Copy Channel ID')
    await w.type('general')
    await w.press(ENTER, loose('a Discord channel id is 17–20 digits'))
    expect(w.frame()).toContain('Discord — channel id')
    await w.erase('general'.length)
    await w.type('123456789012345678')
    await w.press(ENTER, 'Services ▸ summary')
    await w.press('y', 'Integrations ▸ optional')
    const discord = loadNotifyConfig(w.services.notifyConfigPath).channels.discord!
    expect(discord).toEqual({ enabled: true, bot_token_ref: 'discord-bot-token', channel: '123456789012345678' })
    expect(buildChannel('discord', discord, { secrets: w.secretStore })).not.toHaveProperty('problem')
  })

  it('leaves Slack off when its channel is skipped, and says how to finish', async () => {
    const w = await mount('services')
    await w.until('Services ▸ pick which to configure')
    await w.pressInList(DOWN)
    await w.pressInList(DOWN)
    await w.pressInList(SPACE)
    await w.press(ENTER, 'prompt 1 of 2')
    await w.type(FAKE_SLACK_TOKEN)
    await w.press(ENTER, 'Slack — channel')
    await w.erase('#foreman'.length)
    await w.press(ENTER, 'Services ▸ summary')
    await w.until(loose("slack (no channel): foreman notify enable slack --channel '#foreman'"))
    expect(w.secretStore.get('slack-bot-token')).toBe(FAKE_SLACK_TOKEN)
    await w.press('y', 'Integrations ▸ optional')
    expect(existsSync(w.services.notifyConfigPath)).toBe(false)
  })
})

describe('integrations step', () => {
  // An obvious fake in the shape the GitHub token pattern accepts.
  const FAKE_PAT = `ghp_${'F'.repeat(36)}`

  it('resumes at the picker, and empty + Enter skips the step', async () => {
    const w = await mount('integrations')
    await w.until('Step 5 of 6 ▸ Integrations ▸ optional')
    await w.until('GitHub — token')
    await w.until('GitLab — browser sign-in, after setup')
    await w.press(ENTER, 'Required setup')
    expect(loadSetupState().completed).toContain('integrations')
    expect(Object.keys(loadHubConfig(w.mcpConfigPath).servers)).toEqual([])
    expect(w.auditEvents).toEqual([])
  })

  it('adds GitHub with a token: saved disabled, read-only, secret in the store', async () => {
    const w = await mount('integrations')
    await w.until('GitHub — token')
    await w.pressInList(SPACE)
    await w.press(ENTER, 'GitHub (1 of 1) ▸ access level')
    await w.until('read-only (recommended)')
    await w.until('Who can use it: hermes, claude-code')
    await w.press(ENTER, 'GitHub (1 of 1) ▸ credentials')
    await w.until('github.com/settings/personal-access-tokens/new')
    await w.type(FAKE_PAT)
    await w.press(ENTER, 'Integrations ▸ summary')
    await w.until('✓ Saved 1 — off until you review it after setup')
    await w.until('next: foreman integrations review github')
    expect(w.frame()).not.toContain(FAKE_PAT)

    const server = loadHubConfig(w.mcpConfigPath).servers.github!
    expect(server.enabled).toBe(false)
    expect(server.integration).toMatchObject({ id: 'github', variant: 'official', access_level: 'read-only' })
    expect(server.access).toEqual({ agents: ['claude-code', 'hermes'] })
    expect(w.secretStore.get('github-pat')).toBe(FAKE_PAT)
    expect(w.auditEvents.map((e) => e.type)).toEqual(['integration:added'])
    expect(w.auditEvents[0]!.payload).toMatchObject({ integration: 'github', via: 'wizard' })
    expect(JSON.stringify(w.auditEvents)).not.toContain(FAKE_PAT)

    await w.press(ENTER, 'Required setup')
    const saved = loadSetupState()
    expect(saved.completed).toContain('integrations')
    expect(saved.session?.integrationsSelected).toEqual(['github'])
    expect(readFileSync(getSetupStatePath(), 'utf-8')).not.toContain(FAKE_PAT)
  })

  it('refuses a malformed token, and empty Enter leaves the integration out', async () => {
    const w = await mount('integrations')
    await w.until('GitHub — token')
    await w.pressInList(SPACE)
    await w.press(ENTER, '▸ access level')
    await w.press(ENTER, '▸ credentials')
    await w.type('notatoken')
    await w.press(ENTER, "doesn't look like a GitHub personal access token")
    expect(w.frame()).toContain('GitHub (1 of 1) ▸ credentials')
    await w.press(ENTER, 'Integrations ▸ summary')
    await w.until('Skipped: GitHub (no GitHub personal access token)')
    await w.until('no integrations added')
    expect(loadHubConfig(w.mcpConfigPath).servers.github).toBeUndefined()
    expect(w.secretStore.exists('github-pat')).toBe(false)
  })

  it('keeps a token already in the store (e.g. from the old Services step)', async () => {
    const w = await mount('integrations', { secrets: { 'github-pat': FAKE_PAT } })
    await w.until('GitHub — token')
    await w.pressInList(SPACE)
    await w.press(ENTER, '▸ access level')
    await w.press(ENTER, 'already stored — Enter on empty input keeps it')
    await w.press(ENTER, 'Integrations ▸ summary')
    await w.until('✓ Saved 1')
    expect(loadHubConfig(w.mcpConfigPath).servers.github!.integration!.secrets).toEqual({ 'github-pat': 'github-pat' })
    expect(w.secretStore.get('github-pat')).toBe(FAKE_PAT)
  })

  it('saves an OAuth integration for sign-in later and lists the login on Done', async () => {
    const w = await mount('integrations')
    await w.until('GitLab — browser sign-in')
    await w.pressInList(DOWN)
    await w.pressInList(SPACE)
    await w.press(ENTER, 'GitLab (1 of 1) ▸ details')
    await w.until('GitLab host')
    await w.press(ENTER, 'GitLab (1 of 1) ▸ access level')
    await w.until('Signs in through your browser after setup: foreman integrations login gitlab')
    await w.press(ENTER, 'Integrations ▸ summary')
    await w.until('next: foreman integrations login gitlab')
    const server = loadHubConfig(w.mcpConfigPath).servers.gitlab!
    expect(server.enabled).toBe(false)
    expect(server.auth).toBe('oauth')
    expect(server.integration!.params).toEqual({ host: 'gitlab.com' })
    await w.press(ENTER, 'Required setup')
    await w.press('c', '✗ Hermes — install failed')
    await w.press('s', 'Setup complete')
    await w.until('Integrations — off until you review them')
    await w.until('▸ foreman integrations login gitlab')
  })

  it('Esc goes required-setup → integrations → services', async () => {
    const w = await mount('required-setup')
    await w.until('Ready to install')
    await w.press(ESC, 'Integrations ▸ optional')
    await w.press(ESC, 'Services ▸ summary')
  })

  it('says integrations are unavailable when the catalog did not load, and Enter continues', async () => {
    const w = await mount('integrations', { integrations: false })
    await w.until("Integrations can't be set up here")
    await w.press(ENTER, 'Required setup')
  })

  it('no longer offers GitHub, Jira or Notion on the Services step', async () => {
    const w = await mount('services')
    await w.until('Services ▸ pick which to configure')
    await w.until('Telegram')
    expect(w.frame()).not.toMatch(/GitHub —|Notion —|Atlassian|Jira —/)
  })
})

describe('chat-primary step', () => {
  it('asks which chat agent owns a shared channel and saves the pick', async () => {
    const w = await mount('services', { registered: ['hermes', 'openclaw'] })
    await w.until('Services ▸ pick which to configure')
    await w.pressInList(SPACE)
    await w.press(ENTER, 'prompt 1 of 2')
    await w.press(ENTER, 'prompt 2 of 2')
    await w.press(ENTER, 'Services ▸ summary')
    await w.press('y', 'Integrations ▸ optional')
    await w.press(ENTER, 'Primary Telegram agent')
    await w.until('Hermes')
    await w.until('OpenClaw')
    await w.pressInList(DOWN)
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
    await w.press('y', 'Integrations ▸ optional')
    await w.press(ENTER, 'Required setup ▸ missing keys')
    await w.until('openrouter-key')
    await w.until('❯ ⚠ openrouter-key  for: hermes · status: missing')
    await w.press(ENTER, 'paste openrouter-key')
    await w.type('sk-or-fake-000')
    await w.until('•'.repeat('sk-or-fake-000'.length))
    expect(w.frame()).not.toContain('sk-or-fake-000')
    await w.press(ENTER, 'Required setup ▸ all set')
    await w.until('status: saved-in-session')
    expect(w.secretStore.get('openrouter-key')).toBe('sk-or-fake-000')
  })
})

describe('required-setup step [s] skip', () => {
  it('leaves a stored secret alone and still skips a missing one', async () => {
    const w = await mount('agents', { secrets: { 'openai-key': 'sk-fake-openai-000' } })
    await w.until('Agents ▸ pick which to install')
    // Hermes (needs openrouter-key, missing) + OpenClaw (uses the stored openai-key).
    await w.pressInList(DOWN)
    await w.pressInList(SPACE)
    await w.press(ENTER, 'Hermes (1/8)')
    await w.press(ENTER, 'how to reach OpenAI')
    await w.press(ENTER, 'pick a OpenAI model')
    await w.press(ENTER, 'Hermes — responsibility note')
    await w.press(ENTER, 'OpenClaw (5/8)')
    await w.press(ENTER, 'pick a OpenAI model')
    await w.press(ENTER, 'OpenClaw — responsibility note')
    await w.press(ENTER, 'Agents ▸ confirm')
    await w.press('y', 'Services ▸ pick which to configure')
    await w.press(ENTER, 'Services ▸ summary')
    await w.press('y', 'Integrations ▸ optional')
    await w.press(ENTER, 'Required setup ▸ missing keys')
    await w.until(/❯ ✓ openai-key .*status: present/)
    await w.press('s')
    // Used to flip to "✗ … status: skipped" for a key that is in the store.
    await w.until(/❯ ✓ openai-key .*status: present/)
    await w.pressInList(DOWN)
    await w.press('s', 'openrouter-key  for: hermes · status: skipped')
  }, 20_000)
})

describe('required-setup cursor', () => {
  it('keeps a row focused after the list shrinks', async () => {
    const w = await mount('agents', { secrets: { 'openai-key': 'sk-fake-openai-000' } })
    await w.until('Agents ▸ pick which to install')
    // Hermes + OpenClaw → two rows; focus the second.
    await w.pressInList(DOWN)
    await w.pressInList(SPACE)
    await w.press(ENTER, 'Hermes (1/8)')
    await w.press(ENTER, 'how to reach OpenAI')
    await w.press(ENTER, 'pick a OpenAI model')
    await w.press(ENTER, 'Hermes — responsibility note')
    await w.press(ENTER, 'OpenClaw (5/8)')
    await w.press(ENTER, 'pick a OpenAI model')
    await w.press(ENTER, 'OpenClaw — responsibility note')
    await w.press(ENTER, 'Agents ▸ confirm')
    await w.press('y', 'Services ▸ pick which to configure')
    await w.press(ENTER, 'Services ▸ summary')
    await w.press('y', 'Integrations ▸ optional')
    await w.press(ENTER, 'Required setup ▸ missing keys')
    await w.pressInList(DOWN)
    await w.until('❯ ⚠ openrouter-key')
    // Back to the agents picker; keep only OpenClaw → one row left.
    await w.press(ESC, 'Integrations ▸ optional')
    await w.press(ESC, 'Services ▸ summary')
    await w.press(ESC, 'Services ▸ pick which to configure')
    await w.press(ESC, 'Agents ▸ confirm')
    await w.press('n', 'Agents ▸ pick which to install')
    // The picker keeps Hermes + OpenClaw checked (#657): untick Hermes.
    await w.press(SPACE, 'Checked: openclaw')
    await w.press(ENTER, 'OpenClaw (1/4)')
    await w.press(ENTER, 'pick a OpenAI model')
    await w.press(ENTER, 'OpenClaw — responsibility note')
    await w.press(ENTER, 'Agents ▸ confirm')
    await w.press('y', 'Services ▸ pick which to configure')
    await w.press(ENTER, 'Services ▸ summary')
    await w.press('y', 'Integrations ▸ optional')
    await w.press(ENTER, 'Required setup ▸ all set')
    // The stale cursor (1) used to point past the single row: nothing
    // focused, so Enter / [s] / [o] did nothing.
    await w.until('❯ ✓ openai-key')
  }, 40_000)
})

describe('resume into install', () => {
  it('re-opens required setup instead of installing with no keypress', async () => {
    const before = vi.mocked(runInstallStep).mock.calls.length
    // Saved state whose next step is install: the terminal closed mid-install.
    const w = await mount('install')
    await w.until('Ready to install')
    await sleep(300)
    await w.until('Required setup')
    expect(vi.mocked(runInstallStep).mock.calls.length - before).toBe(0)
    await w.press('c', '✗ Hermes — install failed')
    expect(vi.mocked(runInstallStep).mock.calls.length - before).toBe(1)
    await w.press('s', 'Setup complete')
  })
})

describe('install step start', () => {
  it('starts the installer exactly once while the screen re-renders', async () => {
    const before = vi.mocked(runInstallStep).mock.calls.length
    const w = await mount('install')
    await w.startInstall()
    await w.until('✗ Hermes — install failed')
    // Spinner ticks + log lines re-render the install screen many times.
    await sleep(400)
    await w.press('s', 'Setup complete')
    expect(vi.mocked(runInstallStep).mock.calls.length - before).toBe(1)
  })
})

describe('resume keeps session-only choices', () => {
  it('restores per-agent picks, services and notes from setup-state', async () => {
    const first = await mount('agents', { secrets: { 'openai-key': 'sk-fake-openai-000' } })
    await first.until('Agents ▸ pick which to install')
    await first.press(ENTER, 'Hermes (1/4)')
    await first.press(ENTER, 'how to reach OpenAI')
    await first.press(ENTER, 'pick a OpenAI model')
    await first.press(ENTER, 'Hermes — responsibility note')
    await first.type('Code review')
    await first.press(ENTER, 'Agents ▸ confirm')
    await first.press('y', 'Services ▸ pick which to configure')
    // Secrets typed through the wizard's own inputs (all fakes): a service
    // token, then a key pasted on the required-setup screen.
    const typedSecrets = {
      'telegram-bot-token': '123456789:AAHfake_resume_telegram_token_0000000',
      'openrouter-key': 'sk-or-fake-resume-000',
    }
    await first.pressInList(SPACE)
    await first.press(ENTER, 'prompt 1 of 2')
    await first.type(typedSecrets['telegram-bot-token'])
    await first.press(ENTER, 'prompt 2 of 2')
    await first.press(ENTER, 'Services ▸ summary')
    await first.press('y', 'Integrations ▸ optional')
    await first.press(ENTER, 'Required setup ▸ missing keys')
    while (!first.frame().includes('❯ ⚠ openrouter-key')) await first.pressInList(DOWN)
    await first.press(ENTER, 'paste openrouter-key')
    await first.type(typedSecrets['openrouter-key'])
    await first.press(ENTER, 'Required setup ▸ all set')
    // [c] completes required-setup, so a snapshot is written after the paste.
    await first.press('c', '✗ Hermes — install failed')
    for (const [name, value] of Object.entries(typedSecrets)) {
      expect(first.secretStore.get(name)).toBe(value)
    }
    unmount?.()
    unmount = null
    sqlite?.close()
    sqlite = null

    // Like `foreman setup --resume`: a fresh wizard from the file on disk.
    const saved = loadSetupState()
    expect(saved.completed).toContain('required-setup')
    expect(saved.session?.agentConfigs.hermes).toMatchObject({
      llmProvider: 'openai',
      providerVariant: 'via-openrouter',
      responsibilityNote: 'Code review',
    })
    expect(saved.session?.servicesSelected).toEqual(['telegram'])
    // Ids and notes only: none of the typed (or pre-seeded) secret values
    // may reach setup-state.json — they live in the encrypted store.
    const stateText = readFileSync(getSetupStatePath(), 'utf-8')
    for (const value of [...Object.values(typedSecrets), 'sk-fake-openai-000']) {
      expect(stateText).not.toContain(value)
    }

    const resumed = await mount('required-setup', {
      secrets: { 'openai-key': 'sk-fake-openai-000' },
      initialState: saved,
    })
    // Before the fix the resumed run had no per-agent provider, so it
    // showed "No secrets needed" and registered Hermes without an LLM.
    await resumed.until('❯ ⚠ openrouter-key  for: hermes · status: missing')
    await resumed.press('s', 'status: skipped')
    await resumed.press('c', 'Install + configure')
    await resumed.until('✗ Hermes — install failed')
    const call = vi.mocked(runInstallStep).mock.calls.at(-1)
    expect(call?.[4]).toMatchObject({
      hermes: { llmProvider: 'openai', providerVariant: 'via-openrouter' },
    })
    expect(call?.[6]).toEqual({ providersSelected: [], servicesSelected: ['telegram'] })
    await resumed.press('s', 'Setup complete')
  }, 30_000)
})

describe('resume never uninstalls on its own', () => {
  it('re-opens agents confirm for an agent registered after the snapshot, and removes nothing', async () => {
    const first = await mount('agents', { secrets: { 'openai-key': 'sk-fake-openai-000' } })
    await first.until('Agents ▸ pick which to install')
    await first.press(ENTER, 'Hermes (1/4)')
    await first.press(ENTER, 'how to reach OpenAI')
    await first.press(ENTER, 'pick a OpenAI model')
    await first.press(ENTER, 'Hermes — responsibility note')
    await first.press(ENTER, 'Agents ▸ confirm')
    await first.press('y', 'Services ▸ pick which to configure')
    await first.press(ENTER, 'Services ▸ summary')
    await first.press('y', 'Integrations ▸ optional')
    await first.press(ENTER, 'Required setup')
    unmount?.()
    unmount = null
    sqlite?.close()
    sqlite = null
    const saved = loadSetupState()

    // Codex gets registered after the snapshot (another terminal, a
    // half-finished install). The old resume put it in toRemove.
    const before = vi.mocked(runInstallStep).mock.calls.length
    const resumed = await mount('required-setup', {
      secrets: { 'openai-key': 'sk-fake-openai-000' },
      registered: ['codex'],
      initialState: saved,
    })
    await resumed.until('Agents ▸ confirm')
    await resumed.until('▸ Will install: hermes')
    expect(resumed.frame()).not.toContain('Will unregister')
    await resumed.press('y', 'Services ▸ pick which to configure')
    await resumed.press(ENTER, 'Services ▸ summary')
    await resumed.press('y', 'Integrations ▸ optional')
    await resumed.press(ENTER, 'Required setup')
    // One row, already focused: skip the missing key.
    await resumed.until('❯ ⚠ openrouter-key')
    await resumed.press('s', 'status: skipped')
    await resumed.press('c', 'Install + configure')
    await resumed.until('✗ Hermes — install failed')
    const call = vi.mocked(runInstallStep).mock.calls.at(-1)
    expect(vi.mocked(runInstallStep).mock.calls.length - before).toBe(1)
    expect(call?.[0]).toEqual(['hermes'])
    expect(call?.[1]).toEqual([])
    await resumed.press('s', 'Setup complete')
  }, 40_000)
})

describe('install step', () => {
  it('shows the failure prompt, the manual-fix overlay, and resolves skip', async () => {
    const w = await mount('install')
    await w.startInstall()
    await w.until('Selected agents: hermes, claude-code')
    await w.until('✗ Hermes — install failed')
    await w.until('[r] retry · [s] skip this agent · [m] manual fix instructions')
    await w.press('m', 'Manual fix — Hermes')
    await w.until('Run `fake-install` from your shell.')
    await w.press(ESC, '[r] retry')
    await w.press('s', 'Setup complete')
    expect(install.resolution).toBe('skip')
  })
})

describe('foreman-llm step with a subscription sign-in (#575 follow-up)', () => {
  it('acts on the row it draws and explains the pending sign-in', async () => {
    const w = await mount('providers')
    await w.until('pick which to configure')
    await w.pressInList(SPACE)
    await w.press(ENTER, 'How do you want to connect')
    await w.press(DOWN)
    await w.press(ENTER, 'Will sign in with your subscription')
    await w.press('y', "Foreman's brain ▸ pick an LLM")
    await w.until('❯ ✓ Anthropic')
    await w.press(ENTER, 'Anthropic ▸ default model')
    // Used to open the Ollama screen (the key handler ignored sign-ins) or
    // say "No anthropic-key in the secret store".
    expect(w.frame()).not.toContain('Ollama not detected')
    expect(w.frame()).not.toContain('No anthropic-key')
    await w.until('foreman llm login anthropic')
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
    await w.until('anthropic-fake-large')
    expect(vi.mocked(discoverModels)).toHaveBeenLastCalledWith('anthropic', {
      apiKey: 'fake-oauth-access-token',
      auth: 'oauth',
    })
  })
})

describe('done step summary', () => {
  it('counts an OpenAI-compatible preset alongside catalog providers', async () => {
    const w = await mount('done', {
      secrets: { 'openai-key': 'sk-fake-openai-000', 'deepseek-api-key': 'fake-deepseek-000' },
    })
    await w.until('What next?')
    await w.until('2 LLM providers   openai, deepseek')
  })
})

describe('done step identity summary', () => {
  it('does not report an agent without an identity file as a failed push', async () => {
    const w = await mount('install', {
      initialState: {
        version: 1,
        completed: ALL_BEFORE.install,
        startedAt: 1,
        lastUpdatedAt: 1,
        session: {
          providersSelected: [],
          providersSignedIn: [],
          agentsSelected: ['generic-mcp'],
          agentConfigs: {},
          servicesSelected: [],
          // Registry unchanged since the snapshot → no agents review.
          registeredAtSnapshot: [],
        },
      },
    })
    await w.startInstall()
    await w.until('What next?')
    // Nothing to push is not worth a line either (terminal QA).
    expect(w.frame()).not.toContain('No Foreman identity file')
    expect(w.frame()).not.toContain('Identity push failed')
    expect(w.frame()).not.toContain('pushed to 0 of 1')
  })
})

// QA #657 L3 / L9 — at 80x24 the Done screen's top scrolled away (every
// block was spaced twice, and doctor put a blank line between rows), and
// it offered "[q] Exit (skip OAuth)" with no OAuth anywhere.
describe('done step fits 24 rows', () => {
  it('after installing an agent with a token to wire by hand', async () => {
    const w = await mount('install', {
      initialState: {
        version: 1,
        completed: ALL_BEFORE.install,
        startedAt: 1,
        lastUpdatedAt: 1,
        session: {
          providersSelected: [],
          providersSignedIn: [],
          agentsSelected: ['generic-mcp'],
          agentConfigs: {},
          servicesSelected: [],
          registeredAtSnapshot: [],
        },
      },
    })
    await w.startInstall()
    await w.until('What next?')
    const frame = w.frame().replace(/\n+$/, '')
    expect(frame).toContain('Setup complete')
    expect(frame).toContain('foreman agent rewire generic-mcp')
    expect(frame.split('\n').length).toBeLessThanOrEqual(24)
    expect(frame).toMatch(/\[q\]\s+Exit\s*$/m)
    expect(frame).not.toContain('skip OAuth')
    await w.press('d', 'foreman doctor')
    await w.until('✓ 1 ok: fake-check')
  })
})

describe('done step token hand-off (#618)', () => {
  it('names the command that fetches a token Foreman had nowhere to write', async () => {
    const w = await mount('install', {
      initialState: {
        version: 1,
        completed: ALL_BEFORE.install,
        startedAt: 1,
        lastUpdatedAt: 1,
        session: {
          providersSelected: [],
          providersSignedIn: [],
          agentsSelected: ['generic-mcp'],
          agentConfigs: {},
          servicesSelected: [],
          registeredAtSnapshot: [],
        },
      },
    })
    await w.startInstall()
    await w.until('What next?')
    const frame = stripAnsi(w.frame())
    expect(frame).toContain("Wire these agents' identity tokens by hand")
    expect(frame).toContain('foreman agent rewire generic-mcp --token-out <file>')
    expect(frame).not.toMatch(/fat_[A-Za-z0-9_-]{20,}/)
  })
})

describe('done step Node requirement', () => {
  it('repeats why an agent was not installed and the command to run', async () => {
    const w = await mount('install', {
      initialState: {
        version: 1,
        completed: ALL_BEFORE.install,
        startedAt: 1,
        lastUpdatedAt: 1,
        session: {
          providersSelected: [],
          providersSignedIn: [],
          agentsSelected: ['openclaw'],
          agentConfigs: {},
          servicesSelected: [],
          // Registry unchanged since the snapshot → no agents review.
          registeredAtSnapshot: [],
        },
      },
    })
    await w.startInstall()
    await w.until('What next?')
    await w.until('Not installed: these agents need a newer Node.js')
    await w.until('OpenClaw needs Node >=24.16.0 <25 || >=26.1.0')
    await w.until('curl -fsSL https://openclaw.ai/install.sh | bash')
  })
})

describe('done step [Enter] label', () => {
  it('does not promise a TUI under `foreman setup`', async () => {
    const w = await mount('done')
    await w.until('What next?')
    await w.until('[Enter] Finish setup — start Foreman later with `foreman start`')
    expect(w.frame()).not.toContain('Launch Foreman TUI')
  })

  it.each([
    ['exit', '[Enter] Run mandatory OAuth (1 step) + exit'],
    ['launch-tui', '[Enter] Run mandatory OAuth (1 step), then launch Foreman TUI'],
  ] as const)('the mandatory-OAuth label follows afterExit=%s', async (afterExit, label) => {
    // A queued Claude sign-in (restored from the session) makes one
    // mandatory step; the label used to say "+ exit" under both hosts.
    const w = await mount('done', {
      afterExit,
      initialState: {
        version: 1,
        completed: ALL_BEFORE.done,
        startedAt: 1,
        lastUpdatedAt: 1,
        session: {
          providersSelected: ['anthropic'],
          providersSignedIn: ['anthropic'],
          agentsSelected: [],
          agentConfigs: {},
          servicesSelected: [],
          registeredAtSnapshot: [],
        },
      },
    })
    await w.until('What next?')
    await w.until(label)
  })

  it('offers the TUI when the host launches it (`foreman start`)', async () => {
    const w = await mount('done', { afterExit: 'launch-tui' })
    await w.until('What next?')
    await w.until('[Enter] Launch Foreman TUI')
  })
})

describe('done step', () => {
  it('summarises setup and serves the doctor / log / policy hotkeys', async () => {
    const w = await mount('done')
    await w.until('Setup complete — Foreman is ready to guard your agents.')
    await w.until('2 policy rules')
    await w.until('What next?')
    await w.press('d', 'foreman doctor')
    await w.until('fake-check')
    await w.press(ESC, 'What next?')
    await w.press('l', 'Install log')
    await w.press('b', 'What next?')
    await w.press('p')
    await eventually(() => expect(w.launchEditor).toHaveBeenCalledWith(w.services.policyPath))
  })
})
