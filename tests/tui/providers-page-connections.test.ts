import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { RegistryService } from '../../src/core/registry.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { createInMemoryDb } from '../../src/db/client.js'
import { DashboardProvider } from '../../src/tui/dashboard-context.js'
import {
  describeConnections,
  providerConnections,
  ProvidersPage,
} from '../../src/tui/pages/providers-page.js'

// TUI tour: the Providers page didn't say how each provider is connected
// (API key, subscription sign-in or endpoint).

const strip = (s: string | undefined): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '')
const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('provider connections', () => {
  const has = (names: string[]) => (name: string) => names.includes(name)

  it('tells an API key, a subscription sign-in and an endpoint apart', () => {
    const anthropic = { id: 'anthropic', secret_name: 'anthropic-key' }
    expect(providerConnections(anthropic, has(['anthropic-key']))).toEqual(['api-key'])
    expect(providerConnections(anthropic, has(['llm-oauth-anthropic']))).toEqual(['subscription'])
    expect(providerConnections(anthropic, has(['anthropic-key', 'llm-oauth-anthropic']))).toEqual([
      'api-key',
      'subscription',
    ])
    expect(providerConnections({ id: 'ollama', secret_name: null }, has(['ollama-endpoint']))).toEqual(['endpoint'])
    expect(
      providerConnections(
        { id: 'openai-compatible', secret_name: 'openai-compatible-key' },
        has(['openai-compatible-endpoint', 'openai-compatible-key']),
      ),
    ).toEqual(['endpoint', 'api-key'])
    // Only Claude and ChatGPT have a subscription sign-in.
    expect(providerConnections({ id: 'gemini', secret_name: 'gemini-key' }, has(['llm-oauth-gemini']))).toEqual([])
  })

  it('names them in plain words', () => {
    expect(describeConnections('anthropic', ['api-key', 'subscription'])).toBe(
      'API key + Claude subscription sign-in',
    )
    expect(describeConnections('openai', ['subscription'])).toBe('ChatGPT subscription sign-in')
    expect(describeConnections('ollama', ['endpoint'])).toBe('local endpoint')
    expect(describeConnections('openai-compatible', ['endpoint', 'api-key'])).toBe('endpoint + API key')
  })
})

describe('Providers page', () => {
  it('shows how each provider is connected, never a secret value', async () => {
    const { db, sqlite } = createInMemoryDb()
    const bus = new EventBus<ForemanEventMap>()
    const registry = new RegistryService(db, bus)
    const secretStore = new SecretStore(db, Buffer.alloc(32, 7))
    secretStore.add('llm-oauth-anthropic', '{"access":"sk-ant-oat-SECRET"}')
    secretStore.add('openai-key', 'sk-SECRETKEY')
    secretStore.add('ollama-endpoint', 'http://127.0.0.1:11434')
    const app = render(
      React.createElement(DashboardProvider, {
        db,
        sqlite,
        bus,
        registry,
        secretStore,
        children: React.createElement(ProvidersPage, { onLeave: () => {} }),
      }),
    )
    try {
      await tick()
      const frame = strip(app.lastFrame())
      expect(frame).toContain('Anthropic Claude subscription sign-in')
      expect(frame).toContain('OpenAI API key')
      expect(frame).toContain('Local (Ollama) local endpoint')
      expect(frame).toMatch(/Google Gemini \(not connected — \[n\] add an API key\)/)
      expect(frame).toContain('3 connected')
      expect(frame).not.toMatch(/SECRET|127\.0\.0\.1/)
      app.stdin.write('\r')
      await tick()
      expect(strip(app.lastFrame())).toContain('connected with: Claude subscription sign-in')
    } finally {
      app.unmount()
      sqlite.close()
    }
  })
})
