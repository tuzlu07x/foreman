// =============================================================================
// Live model picker — discovers available chat-completion models per provider
// (#399). Hermes' wizard fetches a real model list at setup time; this is
// Foreman's equivalent so users can pick e.g. `gpt-5.4-mini` or
// `claude-opus-4.7` instead of being stuck with the hardcoded
// `gpt-4o-mini` / `claude-haiku-4-5-20251001` defaults.
// =============================================================================
//
// Three providers ship today (OpenAI + Anthropic + Gemini). OpenRouter and
// custom-base proxy support are follow-ups — `DiscoveryProvider` accepts
// strings beyond the union so future providers slot in without a public-API
// break.
//
// Caching: in-memory map keyed on `<provider>:<api-key-hash>` with a default
// 24h TTL. SQLite-backed persistence is a follow-up if wizard re-renders
// turn out to hammer the APIs in practice.

export interface DiscoveredModel {
  /** Bare model id as the provider returns it (e.g. `gpt-4o-mini`,
   *  `claude-opus-4.7`, `gemini-2.5-flash`). What you'd send in an API
   *  call's `model` field. */
  id: string
  /** Human-readable label for the picker UI. Usually `id` itself; some
   *  providers expose a friendlier display name. */
  label: string
  /** Pre-formatted `<provider>/<model>` form that Hermes' `model.default`
   *  and OpenClaw's `agents.defaults.model.primary` expect. */
  slash_id: string
  /** Coarse family bucket for grouping (`gpt-4o`, `gpt-5`, `claude-opus-4`,
   *  `gemini-2.5`, …) — picker can collapse on this if a provider returns
   *  100+ variants. Optional; populated heuristically. */
  family?: string
}

export type DiscoveryProvider = 'openai' | 'anthropic' | 'gemini'

export interface DiscoverOptions {
  apiKey: string
  fetchImpl?: typeof fetch
  /** Per-call timeout. Default 10s. */
  timeoutMs?: number
  /** Cache TTL in ms. Default 24h. Pass 0 to bypass cache entirely. */
  cacheTtlMs?: number
  /** Injectable clock for tests. */
  now?: () => number
}

interface CacheEntry {
  fetchedAt: number
  models: DiscoveredModel[]
}

const memoryCache = new Map<string, CacheEntry>()

export function clearModelsDiscoveryCache(): void {
  memoryCache.clear()
}

/**
 * Provider-agnostic dispatcher with memory cache. The wizard calls this once
 * per provider per setup; cache prevents wizard Esc/Enter cycling from
 * hammering the API.
 */
export async function discoverModels(
  provider: DiscoveryProvider,
  options: DiscoverOptions,
): Promise<DiscoveredModel[]> {
  const ttl = options.cacheTtlMs ?? 24 * 60 * 60 * 1000
  const now = options.now ?? Date.now
  const cacheKey = `${provider}:${hashApiKey(options.apiKey)}`
  if (ttl > 0) {
    const cached = memoryCache.get(cacheKey)
    if (cached && now() - cached.fetchedAt < ttl) return cached.models
  }
  let models: DiscoveredModel[]
  if (provider === 'openai') {
    models = await listOpenAiModels(options)
  } else if (provider === 'anthropic') {
    models = await listAnthropicModels(options)
  } else if (provider === 'gemini') {
    models = await listGeminiModels(options)
  } else {
    throw new Error(`Unknown discovery provider: ${provider as string}`)
  }
  if (ttl > 0) {
    memoryCache.set(cacheKey, { fetchedAt: now(), models })
  }
  return models
}

// =============================================================================
// Provider-specific fetchers
// =============================================================================

export async function listOpenAiModels(
  options: DiscoverOptions,
): Promise<DiscoveredModel[]> {
  const body = await getJson<{ data?: { id: string }[] }>(
    'https://api.openai.com/v1/models',
    {
      headers: { Authorization: `Bearer ${options.apiKey}` },
    },
    options,
  )
  const ids = (body.data ?? []).map((m) => m.id)
  const chat = ids.filter((id) => isOpenAiChatModel(id))
  return chat
    .map(
      (id): DiscoveredModel => ({
        id,
        label: id,
        slash_id: `openai/${id}`,
        family: openAiFamily(id),
      }),
    )
    .sort((a, b) => preferRecent(a.id, b.id))
}

export async function listAnthropicModels(
  options: DiscoverOptions,
): Promise<DiscoveredModel[]> {
  const body = await getJson<{
    data?: { id: string; display_name?: string }[]
  }>(
    'https://api.anthropic.com/v1/models',
    {
      headers: {
        'x-api-key': options.apiKey,
        'anthropic-version': '2023-06-01',
      },
    },
    options,
  )
  const entries = body.data ?? []
  return entries
    .map(
      (m): DiscoveredModel => ({
        id: m.id,
        label: m.display_name ?? m.id,
        slash_id: `anthropic/${m.id}`,
        family: anthropicFamily(m.id),
      }),
    )
    .sort((a, b) => preferRecent(a.id, b.id))
}

export async function listGeminiModels(
  options: DiscoverOptions,
): Promise<DiscoveredModel[]> {
  const url = new URL('https://generativelanguage.googleapis.com/v1beta/models')
  url.searchParams.set('key', options.apiKey)
  const body = await getJson<{
    models?: {
      name?: string
      displayName?: string
      supportedGenerationMethods?: string[]
    }[]
  }>(url.toString(), {}, options)
  const entries = (body.models ?? []).filter((m) =>
    (m.supportedGenerationMethods ?? []).includes('generateContent'),
  )
  return entries
    .map((m): DiscoveredModel | null => {
      const name = m.name ?? ''
      // Gemini returns `models/gemini-2.5-flash` — strip the prefix for
      // user-friendly display + slash-form normalization.
      const bare = name.startsWith('models/') ? name.slice(7) : name
      if (bare.length === 0) return null
      return {
        id: bare,
        label: m.displayName ?? bare,
        slash_id: `google/${bare}`,
        family: geminiFamily(bare),
      }
    })
    .filter((m): m is DiscoveredModel => m !== null)
    .sort((a, b) => preferRecent(a.id, b.id))
}

// =============================================================================
// Helpers
// =============================================================================

async function getJson<T>(
  url: string,
  init: RequestInit,
  options: DiscoverOptions,
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 10_000,
  )
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new ModelDiscoveryError(
        `HTTP ${res.status} from ${url}${body ? `: ${body.slice(0, 200)}` : ''}`,
      )
    }
    return (await res.json()) as T
  } finally {
    clearTimeout(timeout)
  }
}

export class ModelDiscoveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelDiscoveryError'
  }
}

function hashApiKey(key: string): string {
  // We never want full API keys in cache keys (memory inspector visibility,
  // tests that snapshot memoryCache, etc). A short non-cryptographic hash
  // is enough for collision-resistance across two keys for the same provider.
  let h = 5381
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

function isOpenAiChatModel(id: string): boolean {
  // Chat-completion-capable. We exclude embedding/audio/tts/vision-only
  // models because the wizard's "Foreman's brain" picker needs text-out.
  if (/^(gpt-4|gpt-5|gpt-3\.5|chatgpt-)/.test(id)) return true
  if (/^o[1-9](-|$)/.test(id)) return true
  return false
}

function openAiFamily(id: string): string {
  const m = id.match(/^(gpt-\d+(?:\.\d+)?|o\d+|chatgpt)/)
  return m?.[1] ?? id
}

function anthropicFamily(id: string): string {
  // claude-opus-4-7-20250101 → claude-opus-4
  const m = id.match(/^(claude-[a-z]+-\d+)/)
  return m?.[1] ?? id
}

function geminiFamily(id: string): string {
  // gemini-2.5-flash-preview → gemini-2.5
  const m = id.match(/^(gemini-\d+(?:\.\d+)?)/)
  return m?.[1] ?? id
}

function preferRecent(a: string, b: string): number {
  // Heuristic: ids with higher version numbers float to the top. Anthropic
  // and Gemini use embedded version (claude-opus-4.7, gemini-2.5);
  // descending alphabetical sort approximates "newest first".
  return b.localeCompare(a)
}
