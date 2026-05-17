import { describe, expect, it } from 'vitest'
import type { AgentEntry, ProviderEntry } from '../../src/core/registry-catalog.js'
import {
  computeAgentLlmStatus,
  computeAgentLlmStatuses,
} from '../../src/tui/setup-wizard-agent-llm-gating.js'

// =============================================================================
// Pure-logic tests for #297 — smart agent-LLM gating
// =============================================================================
//
// The wizard's agent picker must know which agents are unblocked by the
// LLM keys the user already configured. These tests pin the decision matrix
// for each combination of llm_compat × configured providers.

function pa(overrides: Partial<ProviderEntry>): ProviderEntry {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    description: '',
    secret_name: 'anthropic-key',
    key_prefix: 'sk-ant-',
    where_to_get: null,
    format_hint: null,
    instructions: [],
    endpoint_default: null,
    endpoint_required: false,
    ...overrides,
  }
}

function ag(overrides: Partial<AgentEntry>): AgentEntry {
  return {
    id: 'hermes',
    name: 'Hermes',
    tagline: 'tag',
    homepage: 'https://example.com',
    install: { npm: null, brew: null },
    config_paths: [],
    required_secrets: [],
    optional_secrets: [],
    llm_compat: [],
    mcp_compatible: true,
    supported_versions: '*',
    min_foreman_version: '0.1.0',
    ...overrides,
  }
}

const PROVIDERS: ProviderEntry[] = [
  pa({ id: 'anthropic', name: 'Anthropic' }),
  pa({ id: 'openai', name: 'OpenAI' }),
  pa({ id: 'gemini', name: 'Google Gemini' }),
]

describe('computeAgentLlmStatus — no constraint', () => {
  it('generic-mcp (llm_compat=[]) is always no-constraint', () => {
    const agent = ag({ id: 'generic-mcp', llm_compat: [] })
    const status = computeAgentLlmStatus({
      agent,
      providerCatalog: PROVIDERS,
      configuredProviderIds: [],
    })
    expect(status.state).toBe('no-constraint')
    expect(status.requiredAnyOf).toEqual([])
  })

  it('agent with llm_compat absent is treated as no-constraint', () => {
    const agent = ag({ id: 'generic', llm_compat: undefined })
    const status = computeAgentLlmStatus({
      agent,
      providerCatalog: PROVIDERS,
      configuredProviderIds: ['anthropic'],
    })
    expect(status.state).toBe('no-constraint')
  })
})

describe('computeAgentLlmStatus — single-provider agents', () => {
  it('claude-code (compat=[anthropic]) with anthropic configured → auto-single', () => {
    const agent = ag({ id: 'claude-code', llm_compat: ['anthropic'] })
    const status = computeAgentLlmStatus({
      agent,
      providerCatalog: PROVIDERS,
      configuredProviderIds: ['anthropic'],
    })
    expect(status.state).toBe('auto-single')
    expect(status.availableProviders).toEqual(['anthropic'])
    expect(status.hint).toBe('')
  })

  it('codex (compat=[openai]) without openai → needs-llm with hint', () => {
    const agent = ag({ id: 'codex', llm_compat: ['openai'] })
    const status = computeAgentLlmStatus({
      agent,
      providerCatalog: PROVIDERS,
      configuredProviderIds: [],
    })
    expect(status.state).toBe('needs-llm')
    expect(status.requiredAnyOf).toEqual(['openai'])
    expect(status.hint).toBe('needs OpenAI key')
  })

  it('claude-code without anthropic → needs-llm names Anthropic', () => {
    const agent = ag({ id: 'claude-code', llm_compat: ['anthropic'] })
    const status = computeAgentLlmStatus({
      agent,
      providerCatalog: PROVIDERS,
      configuredProviderIds: ['openai'],
    })
    expect(status.state).toBe('needs-llm')
    expect(status.hint).toBe('needs Anthropic key')
  })
})

describe('computeAgentLlmStatus — multi-provider agents', () => {
  it('hermes (compat=[anthropic, openai]) with both configured → user-choice', () => {
    const agent = ag({ id: 'hermes', llm_compat: ['anthropic', 'openai'] })
    const status = computeAgentLlmStatus({
      agent,
      providerCatalog: PROVIDERS,
      configuredProviderIds: ['anthropic', 'openai'],
    })
    expect(status.state).toBe('user-choice')
    expect(status.availableProviders.sort()).toEqual(['anthropic', 'openai'])
  })

  it('hermes with only openai configured → auto-single (single choice, no picker)', () => {
    const agent = ag({ id: 'hermes', llm_compat: ['anthropic', 'openai'] })
    const status = computeAgentLlmStatus({
      agent,
      providerCatalog: PROVIDERS,
      configuredProviderIds: ['openai'],
    })
    expect(status.state).toBe('auto-single')
    expect(status.availableProviders).toEqual(['openai'])
  })

  it('hermes with no compatible provider configured → needs-llm', () => {
    const agent = ag({ id: 'hermes', llm_compat: ['anthropic', 'openai'] })
    const status = computeAgentLlmStatus({
      agent,
      providerCatalog: PROVIDERS,
      configuredProviderIds: ['gemini'],
    })
    expect(status.state).toBe('needs-llm')
    expect(status.requiredAnyOf).toEqual(['anthropic', 'openai'])
    expect(status.hint).toBe('needs Anthropic or OpenAI key')
  })

  it('openclaw (compat=[anthropic, openai, gemini]) with all three → user-choice', () => {
    const agent = ag({
      id: 'openclaw',
      llm_compat: ['anthropic', 'openai', 'gemini'],
    })
    const status = computeAgentLlmStatus({
      agent,
      providerCatalog: PROVIDERS,
      configuredProviderIds: ['anthropic', 'openai', 'gemini'],
    })
    expect(status.state).toBe('user-choice')
    expect(status.availableProviders.sort()).toEqual([
      'anthropic',
      'gemini',
      'openai',
    ])
  })

  it('openclaw with no compatible LLM → needs-llm with Oxford-comma hint', () => {
    const agent = ag({
      id: 'openclaw',
      llm_compat: ['anthropic', 'openai', 'gemini'],
    })
    const status = computeAgentLlmStatus({
      agent,
      providerCatalog: PROVIDERS,
      configuredProviderIds: [],
    })
    expect(status.state).toBe('needs-llm')
    expect(status.hint).toBe('needs Anthropic, OpenAI or Google Gemini key')
  })
})

describe('computeAgentLlmStatus — edge cases', () => {
  it('compat references an unknown provider id → hint uses the id as fallback', () => {
    const agent = ag({ id: 'weird', llm_compat: ['mystery-provider'] })
    const status = computeAgentLlmStatus({
      agent,
      providerCatalog: PROVIDERS,
      configuredProviderIds: [],
    })
    expect(status.state).toBe('needs-llm')
    expect(status.hint).toBe('needs mystery-provider key')
  })

  it('configured providers that are NOT in agent compat are ignored', () => {
    const agent = ag({ id: 'codex', llm_compat: ['openai'] })
    const status = computeAgentLlmStatus({
      agent,
      providerCatalog: PROVIDERS,
      // user has anthropic + gemini but agent is openai-only
      configuredProviderIds: ['anthropic', 'gemini'],
    })
    expect(status.state).toBe('needs-llm')
    expect(status.availableProviders).toEqual([])
  })
})

describe('computeAgentLlmStatuses — batch', () => {
  it('returns a map keyed by agent id', () => {
    const agents = [
      ag({ id: 'hermes', llm_compat: ['anthropic', 'openai'] }),
      ag({ id: 'codex', llm_compat: ['openai'] }),
      ag({ id: 'generic-mcp', llm_compat: [] }),
    ]
    const statuses = computeAgentLlmStatuses(agents, PROVIDERS, ['anthropic'])
    expect(statuses.get('hermes')?.state).toBe('auto-single')
    expect(statuses.get('codex')?.state).toBe('needs-llm')
    expect(statuses.get('generic-mcp')?.state).toBe('no-constraint')
  })
})
