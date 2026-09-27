import { describe, expect, it } from 'vitest'
import { freshState, type SetupState, type Step, type WizardSessionSnapshot } from '../../src/tui/setup-state.js'
import { computeAgentDiff } from '../../src/tui/setup-wizard/agents-logic.js'
import { planResume } from '../../src/tui/setup-wizard/resume.js'

// =============================================================================
// Resume must never uninstall on its own. Install derives removals from
// agentsSelected vs the live registry; with agentsSelected restored from a
// snapshot, an agent registered after the snapshot landed in toRemove and
// was unregistered + uninstalled with no "Will remove" screen.
// =============================================================================

const catalog = {
  agents: [
    { id: 'hermes', llm_compat: ['anthropic', 'openai'] },
    { id: 'codex', llm_compat: ['openai'] },
  ],
  providerIds: ['anthropic', 'openai'],
  serviceIds: ['telegram'],
}

const UP_TO_REQUIRED: Step[] = ['welcome', 'providers', 'foreman-llm', 'agents', 'services', 'chat-primary']

function resumed(session: Partial<WizardSessionSnapshot>, completed: Step[] = UP_TO_REQUIRED): SetupState {
  return {
    ...freshState(),
    completed,
    session: {
      providersSelected: [],
      providersSignedIn: [],
      agentsSelected: ['hermes'],
      agentConfigs: {},
      servicesSelected: [],
      ...session,
    },
  }
}

function removals(plan: ReturnType<typeof planResume>, live: string[]): string[] {
  return computeAgentDiff(plan.setup.session?.agentsSelected ?? [], live).toRemove
}

describe('planResume', () => {
  it('keeps the plan when the registry matches the snapshot', () => {
    const plan = planResume(resumed({ registeredAtSnapshot: [] }), [], catalog)
    expect(plan.agentsPhase).toBeNull()
    expect(plan.setup.completed).toEqual(UP_TO_REQUIRED)
    expect(plan.setup.session?.agentsSelected).toEqual(['hermes'])
  })

  it('never removes an agent registered after the snapshot, and re-opens confirm', () => {
    const live = ['codex']
    const plan = planResume(resumed({ registeredAtSnapshot: [] }), live, catalog)
    expect(removals(plan, live)).toEqual([])
    expect(plan.setup.session?.agentsSelected).toEqual(['hermes', 'codex'])
    expect(plan.agentsPhase).toBe('confirm')
    expect(plan.setup.completed).toEqual(['welcome', 'providers', 'foreman-llm'])
  })

  it('does not act on a removal the snapshot asked for; the user reviews it instead', () => {
    const live = ['codex']
    const plan = planResume(resumed({ registeredAtSnapshot: ['codex'] }), live, catalog)
    expect(removals(plan, live)).toEqual([])
    expect(plan.agentsPhase).toBe('confirm')
  })

  it('re-opens confirm for a snapshot without a baseline', () => {
    const plan = planResume(resumed({}), [], catalog)
    expect(plan.agentsPhase).toBe('confirm')
  })

  it('drops agents the catalog no longer has, and re-opens confirm', () => {
    const plan = planResume(
      resumed({ agentsSelected: ['hermes', 'retired-agent'], registeredAtSnapshot: [] }),
      [],
      catalog,
    )
    expect(plan.setup.session?.agentsSelected).toEqual(['hermes'])
    expect(plan.agentsPhase).toBe('confirm')
  })

  it('keeps a live agent the catalog does not list (never removed)', () => {
    const live = ['custom-agent']
    const plan = planResume(resumed({ registeredAtSnapshot: [] }), live, catalog)
    expect(removals(plan, live)).toEqual([])
  })

  it('re-opens required setup when the next step would be install', () => {
    // With or without a session: nothing may start installing on mount.
    const upToInstall: Step[] = [...UP_TO_REQUIRED, 'required-setup']
    const bare = planResume({ ...freshState(), completed: upToInstall }, [], catalog)
    expect(bare.setup.completed).toEqual(UP_TO_REQUIRED)
    const withSession = planResume(resumed({ registeredAtSnapshot: [] }, upToInstall), [], catalog)
    expect(withSession.setup.completed).toEqual(UP_TO_REQUIRED)
    expect(withSession.agentsPhase).toBeNull()
  })

  it('leaves a run alone before the agents step and after install', () => {
    const early = planResume(resumed({}, ['welcome', 'providers']), ['codex'], catalog)
    expect(early.agentsPhase).toBeNull()
    expect(early.setup.completed).toEqual(['welcome', 'providers'])
    const done = planResume(resumed({}, [...UP_TO_REQUIRED, 'required-setup', 'install']), ['codex'], catalog)
    expect(done.agentsPhase).toBeNull()
    expect(done.setup.completed).toContain('install')
  })
})
