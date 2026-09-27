import { describe, expect, it } from 'vitest'
import { loadActiveRegistry, type AgentEntry } from '../../src/core/registry-catalog.js'
import {
  applyLlmChoice,
  buildAgentConfigPromptList,
  previousShownAgentPromptIdx,
  variantPickIsShown,
} from '../../src/tui/setup-wizard/agents-logic.js'

// =============================================================================
// Esc inside the per-agent config queue. Esc on model-pick used to step to
// the prompt immediately before it — for single-variant agents that is an
// auto-skipped variant prompt that bounced straight back, so Esc looped.
// Esc on variant-pick for single-provider agents landed on the PREVIOUS
// agent's responsibility note. Uses the real bundled registry entries.
// =============================================================================

const agents = loadActiveRegistry().doc.agents
function agent(id: string): AgentEntry {
  const found = agents.find((a) => a.id === id)
  if (!found) throw new Error(`registry has no ${id}`)
  return found
}

describe('variantPickIsShown', () => {
  it('is false for a single-variant route (OpenClaw on OpenAI)', () => {
    expect(variantPickIsShown(agent('openclaw'), { llmProvider: 'openai' }, undefined)).toBe(false)
  })

  it('is true for a multi-variant route the user has to choose (Hermes on OpenAI)', () => {
    expect(variantPickIsShown(agent('hermes'), { llmProvider: 'openai' }, undefined)).toBe(true)
  })

  it('is false once Foreman auto-picked the no-credential route (Codex OAuth)', () => {
    expect(
      variantPickIsShown(
        agent('codex'),
        { llmProvider: 'openai', providerVariant: 'oauth' },
        { variantId: 'oauth' },
      ),
    ).toBe(false)
  })

  it('uses the sole compatible provider for single-provider agents (Claude Code)', () => {
    expect(variantPickIsShown(agent('claude-code'), {}, undefined)).toBe(true)
  })
})

describe('previousShownAgentPromptIdx', () => {
  it('steps over an auto-skipped variant prompt back to the provider choice', () => {
    const prompts = buildAgentConfigPromptList(agents, ['openclaw'], ['openai'])
    expect(prompts.map((p) => p.kind)).toEqual([
      'llm-choice',
      'variant-pick',
      'model-pick',
      'responsibility-note',
    ])
    const shown = (kind: string): boolean => kind !== 'variant-pick'
    expect(previousShownAgentPromptIdx(prompts, 2, (p) => shown(p.kind))).toBe(0)
  })

  it("never crosses into the previous agent's prompts", () => {
    const prompts = buildAgentConfigPromptList(
      agents,
      ['hermes', 'claude-code'],
      ['openai', 'anthropic'],
    )
    const claudeVariant = prompts.findIndex(
      (p) => p.agentId === 'claude-code' && p.kind === 'variant-pick',
    )
    expect(prompts[claudeVariant - 1]).toEqual({
      agentId: 'hermes',
      kind: 'responsibility-note',
    })
    expect(previousShownAgentPromptIdx(prompts, claudeVariant, () => true)).toBeNull()
  })
})

describe('applyLlmChoice', () => {
  it('keeps the variant + model when the provider is unchanged', () => {
    expect(
      applyLlmChoice(
        { llmProvider: 'openai', providerVariant: 'via-openrouter', modelVersion: 'm' },
        'openai',
      ),
    ).toEqual({ llmProvider: 'openai', providerVariant: 'via-openrouter', modelVersion: 'm' })
  })

  it("drops the old provider's variant + model when the provider changes", () => {
    expect(
      applyLlmChoice(
        {
          llmProvider: 'openai',
          providerVariant: 'via-codex-oauth',
          modelVersion: 'm',
          responsibilityNote: 'Code review',
        },
        'anthropic',
      ),
    ).toEqual({ llmProvider: 'anthropic', responsibilityNote: 'Code review' })
  })
})
