import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  freshState,
  loadSetupState,
  sanitizeSession,
  saveSetupState,
  type SetupState,
  type WizardSessionSnapshot,
} from '../../src/tui/setup-state.js'
import {
  createInitialWizardState,
  snapshotSession,
} from '../../src/tui/setup-wizard/state.js'

// =============================================================================
// Session-only wizard choices survive a resume. They used to live only in
// React state, so `foreman setup --resume` registered multi-provider agents
// with no LLM provider and forgot the selected services + queued sign-ins.
// =============================================================================

const session: WizardSessionSnapshot = {
  providersSelected: ['openai'],
  providersSignedIn: ['anthropic'],
  agentsSelected: ['hermes', 'openclaw'],
  agentConfigs: {
    hermes: {
      llmProvider: 'openai',
      providerVariant: 'via-openrouter',
      modelVersion: 'gpt-fake',
      responsibilityNote: 'Code review',
    },
  },
  servicesSelected: ['telegram'],
}

describe('setup-state session snapshot', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'setup-state-session-'))
    path = join(dir, 'setup-state.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips through save + load', () => {
    const state: SetupState = { ...freshState(), completed: ['welcome', 'providers'], session }
    saveSetupState(state, path)
    expect(loadSetupState(path).session).toEqual(session)
  })

  it('still loads a file written before the snapshot existed', () => {
    writeFileSync(
      path,
      JSON.stringify({ version: 1, completed: ['welcome'], startedAt: 1, lastUpdatedAt: 2 }),
    )
    const loaded = loadSetupState(path)
    expect(loaded.completed).toEqual(['welcome'])
    expect(loaded.session).toBeUndefined()
  })

  it('keeps completed steps when the snapshot is damaged', () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        completed: ['welcome', 'providers'],
        startedAt: 1,
        lastUpdatedAt: 2,
        session: { agentsSelected: 'not-a-list' },
      }),
    )
    const loaded = loadSetupState(path)
    expect(loaded.completed).toEqual(['welcome', 'providers'])
    expect(loaded.session).toBeUndefined()
  })
})

describe('sanitizeSession', () => {
  it('drops unknown fields and non-subscription provider ids', () => {
    expect(
      sanitizeSession({
        ...session,
        providersSignedIn: ['anthropic', 'gemini'],
        agentConfigs: { hermes: { llmProvider: 'openai', apiKey: 'should-not-survive' } },
      }),
    ).toEqual({
      ...session,
      providersSignedIn: ['anthropic'],
      agentConfigs: { hermes: { llmProvider: 'openai' } },
    })
  })
})

describe('sanitizeSession with a catalog', () => {
  const catalog = {
    agents: [
      {
        id: 'hermes',
        llm_compat: ['anthropic', 'openai'],
        provider_mapping: { openai: { variants: { 'via-openrouter': {}, 'via-codex-oauth': {} } } },
      },
      { id: 'codex', llm_compat: ['openai'], provider_mapping: { openai: { variants: { oauth: {} } } } },
    ],
    providerIds: ['anthropic', 'openai'],
    serviceIds: ['telegram'],
  }

  it('drops agent, provider and service ids the registry no longer knows', () => {
    const out = sanitizeSession(
      {
        providersSelected: ['openai', 'retired-provider'],
        providersSignedIn: [],
        agentsSelected: ['hermes', 'retired-agent'],
        agentConfigs: { hermes: { llmProvider: 'openai' }, 'retired-agent': { llmProvider: 'openai' } },
        servicesSelected: ['telegram', 'retired-service'],
      },
      catalog,
    )
    expect(out?.providersSelected).toEqual(['openai'])
    expect(out?.agentsSelected).toEqual(['hermes'])
    expect(Object.keys(out?.agentConfigs ?? {})).toEqual(['hermes'])
    expect(out?.servicesSelected).toEqual(['telegram'])
  })

  it("drops a per-agent provider or variant the agent's mapping doesn't declare", () => {
    const out = sanitizeSession(
      {
        providersSelected: [],
        providersSignedIn: [],
        agentsSelected: ['hermes', 'codex'],
        agentConfigs: {
          // gemini isn't in hermes' llm_compat → provider, route and model go.
          hermes: { llmProvider: 'gemini', providerVariant: 'direct', modelVersion: 'm', responsibilityNote: 'n' },
          // single-provider agent: variant checked against its sole provider.
          codex: { providerVariant: 'retired-route' },
        },
        servicesSelected: [],
      },
      catalog,
    )
    expect(out?.agentConfigs).toEqual({ hermes: { responsibilityNote: 'n' }, codex: {} })
  })
})

describe('snapshotSession whitelist', () => {
  it('keeps only the four per-agent fields', () => {
    const s = createInitialWizardState(freshState(), [])
    const withExtra = {
      ...s,
      agentConfigs: {
        hermes: { llmProvider: 'openai', apiKey: 'fake-should-not-persist' } as unknown as WizardSessionSnapshot['agentConfigs'][string],
      },
    }
    expect(snapshotSession(withExtra).agentConfigs).toEqual({ hermes: { llmProvider: 'openai' } })
  })
})

describe('wizard state ↔ snapshot', () => {
  it('seeds a resumed wizard from the snapshot', () => {
    const s = createInitialWizardState({ ...freshState(), session }, ['codex'])
    expect(s.providersSelected).toEqual(['openai'])
    expect(s.providersSignedIn).toEqual(['anthropic'])
    expect(s.agentsSelected).toEqual(['hermes', 'openclaw'])
    expect(s.agentConfigs).toEqual(session.agentConfigs)
    expect(s.servicesSelected).toEqual(['telegram'])
  })

  it('snapshots exactly what it seeds', () => {
    const s = createInitialWizardState({ ...freshState(), session }, [])
    expect(snapshotSession(s)).toEqual(session)
  })
})
