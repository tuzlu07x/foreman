import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import type { AgentEntry } from './registry-catalog.js'
import type { SecretStore } from './secret-store.js'

// =============================================================================
// Agent secrets projector (#222 / #223)
// =============================================================================
//
// Bridges Foreman's encrypted secret store → the agent's own config/env files
// at install time, so a fresh `foreman setup` produces agents that launch
// without any extra manual config in the agent's own setup tools.
//
// Four writer strategies, picked per agent's registry `secret_projection` block:
//   - dotenv          → Hermes (`~/.hermes/.env`)
//   - json env block  → Claude Code, OpenClaw (`env` key inside settings.json)
//   - json channels   → OpenClaw (`channels.telegram.botToken` etc, deep merge)
//   - toml writes     → Codex (`preferred_auth_method`), ZeroClaw (`api_key`)
//   - auth json file  → Codex (`~/.codex/auth.json` — flat JSON map)
//
// All writers are atomic (tmpfile + rename), chmod 0600, and deep-merge so
// sibling keys the user added by hand survive.

export interface ProjectionContext {
  /** Provider ids the user picked (drives `if_provider` filters). */
  providersSelected: string[]
  /** Service ids the user picked (drives `if_service` filters). */
  servicesSelected: string[]
  /** Source of truth for secret values. */
  secretStore: SecretStore
  /** Override $HOME (mostly for tests). */
  home?: string
}

export interface WrittenFile {
  path: string
  /** Which secret names landed in this file. */
  secrets: string[]
  /** Was the file new, or did we update an existing one? */
  created: boolean
  /** Did we replace a different stale value (rotation flow, #215). */
  replacedStale: boolean
}

export interface ProjectionResult {
  agentId: string
  files: WrittenFile[]
  /** Secret refs we tried to project but couldn't (secret missing in store, etc). */
  skipped: { secret: string; reason: string }[]
}

/**
 * Walk an agent's `secret_projection` block and write everything that applies
 * to the user's current selection. Idempotent: re-running with the same input
 * is a no-op (writers detect identical values).
 */
export function projectSecretsForAgent(
  entry: AgentEntry,
  ctx: ProjectionContext,
): ProjectionResult {
  const result: ProjectionResult = { agentId: entry.id, files: [], skipped: [] }
  const projection = entry.secret_projection
  if (!projection) return result

  const home = ctx.home ?? homedir()
  const expand = (p: string): string =>
    p.startsWith('~/') ? resolve(home, p.slice(2)) : resolve(p)

  // -----------------------------------------------------------------------
  // 1) env_vars → dotenv OR json env block
  // -----------------------------------------------------------------------
  const envPairs: Record<string, string> = {}
  const envSecretNames: string[] = []
  if (projection.env_vars) {
    for (const [varName, spec] of Object.entries(projection.env_vars)) {
      if (!filterMatches(spec, ctx)) continue
      const value = safeGet(ctx.secretStore, spec.from_secret, result.skipped)
      if (value === null) continue
      envPairs[varName] = value
      envSecretNames.push(spec.from_secret)
    }
  }

  if (projection.env_file && Object.keys(envPairs).length > 0) {
    const path = expand(projection.env_file)
    const w = writeDotenv(path, envPairs)
    result.files.push({ path, secrets: envSecretNames, ...w })
  }
  if (projection.json_env && Object.keys(envPairs).length > 0) {
    const path = expand(projection.json_env.path)
    const w = writeJsonEnvBlock(path, projection.json_env.section, envPairs)
    result.files.push({ path, secrets: envSecretNames, ...w })
  }

  // -----------------------------------------------------------------------
  // 2) json_channels → nested deep-merge
  // -----------------------------------------------------------------------
  if (projection.json_channels) {
    const path = expand(projection.json_channels.path)
    const pairs: { dotPath: string; value: string; secret: string }[] = []
    for (const [, spec] of Object.entries(projection.json_channels.channels)) {
      if (!filterMatches(spec, ctx)) continue
      const value = safeGet(ctx.secretStore, spec.from_secret, result.skipped)
      if (value === null) continue
      pairs.push({ dotPath: spec.path, value, secret: spec.from_secret })
    }
    if (pairs.length > 0) {
      const w = writeJsonChannels(path, pairs)
      result.files.push({ path, secrets: pairs.map((p) => p.secret), ...w })
    }
  }

  // -----------------------------------------------------------------------
  // 3) toml_writes → flat key=value
  // -----------------------------------------------------------------------
  if (projection.toml_writes && projection.toml_writes.length > 0) {
    const grouped = new Map<
      string,
      { key: string; value: string; secret: string | null }[]
    >()
    for (const w of projection.toml_writes) {
      let value: string
      let secret: string | null = null
      if (typeof w.value === 'string') {
        value = w.value
      } else {
        const v = safeGet(ctx.secretStore, w.value.from_secret, result.skipped)
        if (v === null) continue
        value = v
        secret = w.value.from_secret
      }
      const key = w.key
      const path = expand(w.path)
      const list = grouped.get(path) ?? []
      list.push({ key, value, secret })
      grouped.set(path, list)
    }
    for (const [path, writes] of grouped.entries()) {
      const written = writeTomlFields(path, writes)
      result.files.push({
        path,
        secrets: writes.map((w) => w.secret).filter((s): s is string => s !== null),
        ...written,
      })
    }
  }

  // -----------------------------------------------------------------------
  // 4) auth_json → flat JSON map (Codex's auth.json)
  // -----------------------------------------------------------------------
  if (projection.auth_json) {
    if (filterMatches(projection.auth_json, ctx)) {
      const value = safeGet(
        ctx.secretStore,
        projection.auth_json.from_secret,
        result.skipped,
      )
      if (value !== null) {
        const path = expand(projection.auth_json.path)
        const w = writeAuthJson(path, projection.auth_json.key, value)
        result.files.push({
          path,
          secrets: [projection.auth_json.from_secret],
          ...w,
        })
      }
    }
  }

  return result
}

function filterMatches(
  spec: { if_provider?: string; if_service?: string },
  ctx: ProjectionContext,
): boolean {
  if (spec.if_provider && !ctx.providersSelected.includes(spec.if_provider)) {
    return false
  }
  if (spec.if_service && !ctx.servicesSelected.includes(spec.if_service)) {
    return false
  }
  return true
}

function safeGet(
  store: SecretStore,
  name: string,
  skipped: ProjectionResult['skipped'],
): string | null {
  try {
    if (!store.exists(name)) {
      skipped.push({ secret: name, reason: 'not in secret store' })
      return null
    }
    return store.get(name)
  } catch (err) {
    skipped.push({
      secret: name,
      reason: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

// =============================================================================
// Writers
// =============================================================================

interface WriteOutcome {
  created: boolean
  replacedStale: boolean
}

/**
 * Dotenv writer (Hermes). Merge with existing lines, replace duplicates,
 * preserve user comments / blank lines / unrelated keys.
 */
export function writeDotenv(
  path: string,
  vars: Record<string, string>,
): WriteOutcome {
  const exists = existsSync(path)
  const existing = exists ? readFileSync(path, 'utf-8') : ''
  const lines = existing.split('\n')
  const seen = new Set<string>()
  let replacedStale = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (!m) continue
    const key = m[1]!
    if (vars[key] !== undefined) {
      const newLine = `${key}=${quote(vars[key]!)}`
      if (line !== newLine) replacedStale = true
      lines[i] = newLine
      seen.add(key)
    }
  }
  const additions: string[] = []
  for (const [k, v] of Object.entries(vars)) {
    if (!seen.has(k)) additions.push(`${k}=${quote(v)}`)
  }
  let merged = lines.join('\n')
  if (additions.length > 0) {
    if (merged.length > 0 && !merged.endsWith('\n')) merged += '\n'
    merged += additions.join('\n') + '\n'
  } else if (merged.length > 0 && !merged.endsWith('\n')) {
    merged += '\n'
  }
  atomicWrite0600(path, merged)
  return { created: !exists, replacedStale }
}

/**
 * JSON deep-merge into a nested object at `section` (a dot-path). Preserves
 * every other top-level + nested key.
 */
export function writeJsonEnvBlock(
  path: string,
  section: string,
  vars: Record<string, string>,
): WriteOutcome {
  const exists = existsSync(path)
  let root: Record<string, unknown> = {}
  if (exists) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>
      }
    } catch {
      // Malformed JSON: start fresh, don't blow up the user's setup.
    }
  }
  const previous = readDotPath(root, section)
  const previousObj =
    previous && typeof previous === 'object' && !Array.isArray(previous)
      ? (previous as Record<string, unknown>)
      : {}
  const replacedStale = Object.entries(vars).some(
    (entry) => previousObj[entry[0]] !== undefined && previousObj[entry[0]] !== entry[1],
  )
  const next = { ...previousObj, ...vars }
  writeDotPath(root, section, next)
  atomicWrite0600(path, JSON.stringify(root, null, 2) + '\n')
  return { created: !exists, replacedStale }
}

/**
 * Deep-merge nested dot-paths inside a JSON file (e.g.
 * `channels.telegram.botToken = "…"`).
 */
export function writeJsonChannels(
  path: string,
  pairs: { dotPath: string; value: string }[],
): WriteOutcome {
  const exists = existsSync(path)
  let root: Record<string, unknown> = {}
  if (exists) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>
      }
    } catch {
      // Malformed JSON: start fresh.
    }
  }
  let replacedStale = false
  for (const { dotPath, value } of pairs) {
    const prev = readDotPath(root, dotPath)
    if (prev !== undefined && prev !== value) replacedStale = true
    writeDotPath(root, dotPath, value)
  }
  atomicWrite0600(path, JSON.stringify(root, null, 2) + '\n')
  return { created: !exists, replacedStale }
}

/**
 * Top-level TOML key=value writer. Preserves table headers + comments + sibling
 * keys by doing a line-level rewrite rather than a full parse/re-emit.
 */
export function writeTomlFields(
  path: string,
  writes: { key: string; value: string }[],
): WriteOutcome {
  const exists = existsSync(path)
  const existing = exists ? readFileSync(path, 'utf-8') : ''
  const lines = existing.split('\n')
  // Find the top-level (non-table) region — everything before the first `[…]`
  // header. We only update keys in this region; if a key is inside a table,
  // we still rewrite it but only if it's the exact same simple top-level
  // assignment. Conservative.
  let firstHeaderIdx = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) {
      firstHeaderIdx = i
      break
    }
  }
  const seen = new Set<string>()
  let replacedStale = false
  for (let i = 0; i < firstHeaderIdx; i++) {
    const line = lines[i]!
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=/)
    if (!m) continue
    const key = m[1]!
    const w = writes.find((x) => x.key === key)
    if (!w) continue
    const newLine = `${key} = ${tomlQuote(w.value)}`
    if (line !== newLine) replacedStale = true
    lines[i] = newLine
    seen.add(key)
  }
  const additions: string[] = []
  for (const w of writes) {
    if (!seen.has(w.key)) additions.push(`${w.key} = ${tomlQuote(w.value)}`)
  }
  let merged = lines.join('\n')
  if (additions.length > 0) {
    // Insert top-level additions before the first table header, or at the end
    // of file if there are no headers.
    if (firstHeaderIdx < lines.length) {
      const before = lines.slice(0, firstHeaderIdx).join('\n')
      const after = lines.slice(firstHeaderIdx).join('\n')
      const prefix =
        before.length > 0 && !before.endsWith('\n') ? `${before}\n` : before
      merged = prefix + additions.join('\n') + '\n' + after
    } else {
      if (merged.length > 0 && !merged.endsWith('\n')) merged += '\n'
      merged += additions.join('\n') + '\n'
    }
  } else if (merged.length > 0 && !merged.endsWith('\n')) {
    merged += '\n'
  }
  atomicWrite0600(path, merged)
  return { created: !exists, replacedStale }
}

/**
 * Flat JSON map writer (Codex `auth.json`). Preserves siblings.
 */
export function writeAuthJson(
  path: string,
  key: string,
  value: string,
): WriteOutcome {
  const exists = existsSync(path)
  let root: Record<string, unknown> = {}
  if (exists) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>
      }
    } catch {
      /* fall through */
    }
  }
  const replacedStale = root[key] !== undefined && root[key] !== value
  root[key] = value
  atomicWrite0600(path, JSON.stringify(root, null, 2) + '\n')
  return { created: !exists, replacedStale }
}

// =============================================================================
// Helpers
// =============================================================================

function atomicWrite0600(path: string, content: string): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${path}.foreman.tmp`
  writeFileSync(tmp, content, { mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    /* some platforms reject; harmless */
  }
  renameSync(tmp, path)
}

function quote(v: string): string {
  // Dotenv: quote only if the value contains whitespace, quotes, or `#`.
  if (/[\s#"']/.test(v)) return `"${v.replace(/"/g, '\\"')}"`
  return v
}

function tomlQuote(v: string): string {
  // Always quote as a basic string for simplicity. Escape backslash + quote.
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function readDotPath(root: unknown, dotPath: string): unknown {
  const segs = dotPath.split('.')
  let cur: unknown = root
  for (const seg of segs) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

function writeDotPath(
  root: Record<string, unknown>,
  dotPath: string,
  value: unknown,
): void {
  const segs = dotPath.split('.')
  let cur: Record<string, unknown> = root
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!
    const existing = cur[seg]
    if (
      existing === null ||
      existing === undefined ||
      typeof existing !== 'object' ||
      Array.isArray(existing)
    ) {
      const next: Record<string, unknown> = {}
      cur[seg] = next
      cur = next
    } else {
      cur = existing as Record<string, unknown>
    }
  }
  cur[segs[segs.length - 1]!] = value
}
