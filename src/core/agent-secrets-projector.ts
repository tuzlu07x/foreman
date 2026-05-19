import { randomBytes } from 'node:crypto'
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
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  deriveDefaultModelId,
  describeResolveError,
  resolveAgentProviderConfig,
  type ResolvedAgentProviderConfig,
} from './provider-resolver.js'
import {
  resolveBundledTemplatePath,
  type AgentEntry,
} from './registry-catalog.js'
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
  /** #389 — Per-agent LLM provider choice. Drives `if_provider` on
   *  `config_overrides` writes so e.g. Hermes' config.yaml gets
   *  `model.provider: openai` when the user picked openai. Optional;
   *  when omitted, no per-agent override fires. */
  llmProvider?: string
  /** Source of truth for secret values. */
  secretStore: SecretStore
  /** Override $HOME (mostly for tests). */
  home?: string
  /** #426 — Primary chat agent per channel. When set + an entry has
   *  `if_service: telegram` (or another messaging channel), the
   *  projector writes the secret only if the agent being projected is
   *  the configured primary for that channel. When omitted: legacy
   *  behavior (every selected agent gets the channel's secrets). */
  chatPrimary?: {
    isPrimary(channel: string, agentId: string): boolean
  }
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

  // #377 — Some agents (OpenClaw) need their own config file to exist with
  // their full schema before Foreman can safely overlay keys. When the
  // registry flags this and the target doesn't yet exist, skip the JSON
  // writes entirely so we don't create a stripped-down file that the
  // agent's binary then rejects with "invalid config".
  // #385 — When `install.config_template_path` is set AND the target is
  // missing, seed it from the bundled template first so the rest of the
  // projection has a schema-valid file to overlay onto. Eliminates the
  // need for the user to run `<agent> onboard` + `foreman secrets repush`.
  const requiresExisting = entry.install.requires_existing_config === true
  const seedTemplateIfMissing = (path: string): boolean => {
    if (existsSync(path)) return true
    if (!entry.install.config_template_path) return false
    const templatePath = resolveBundledTemplatePath(
      entry.install.config_template_path,
    )
    if (!templatePath) return false
    try {
      const contents = readFileSync(templatePath, 'utf-8')
      // Expand `~/` in the template body itself so workspace paths are
      // user-specific. Template should keep `~/` literal; we substitute here.
      const expanded = contents.replace(/~\//g, `${home}/`)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, expanded, { mode: 0o600 })
      return true
    } catch {
      return false
    }
  }

  // -----------------------------------------------------------------------
  // 0) #408 / #410 Phase 2 — resolver path. If the agent declares
  //    `provider_mapping` AND the user picked a Foreman LLM provider,
  //    delegate provider-specific writes (env_vars, config_overrides,
  //    auth_json, toml_writes) to the resolver. Channels + security_bootstrap
  //    stay on the legacy path because they're not provider-coupled.
  // -----------------------------------------------------------------------
  let resolverWonProviderWrites = false
  if (entry.provider_mapping && ctx.llmProvider) {
    const lookup = (name: string): string | null => {
      try {
        if (!ctx.secretStore.exists(name)) return null
        return ctx.secretStore.get(name)
      } catch {
        return null
      }
    }
    const resolved = resolveAgentProviderConfig({
      agent: entry,
      foremanProvider: ctx.llmProvider,
      // Phase 2 hardcoded default — Phase 3 wizard / PR #405 picker
      // will pass through the user's actual choice.
      modelId: deriveDefaultModelId(ctx.llmProvider),
      secretLookup: lookup,
    })
    if (resolved.ok) {
      resolverWonProviderWrites = true
      applyResolverWrites(
        entry,
        resolved.config,
        result,
        expand,
        seedTemplateIfMissing,
        requiresExisting,
        projection,
      )
    } else {
      // Resolver gave up — log + fall through to legacy provider-specific
      // sections so existing config_overrides etc still fire.
      result.skipped.push({
        secret: '(provider_mapping)',
        reason: describeResolveError(resolved.error),
      })
    }
  }

  // -----------------------------------------------------------------------
  // 1) env_vars → dotenv OR json env block
  //    Per-entry gate (#425): when the resolver wins, skip ONLY the
  //    entries that have `if_provider` set — the resolver already wrote
  //    those. Entries with `if_service` (Telegram bot tokens, allowed
  //    users, etc.) MUST still fire — the resolver never touches them.
  // -----------------------------------------------------------------------
  const envPairs: Record<string, string> = {}
  const envSecretNames: string[] = []
  if (projection.env_vars) {
    for (const [varName, spec] of Object.entries(projection.env_vars)) {
      if (resolverWonProviderWrites && spec.if_provider) continue
      if (!filterMatches(spec, ctx, entry.id)) continue
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
    // #385 — Try to seed from bundled template first. seedTemplateIfMissing
    // returns true if the path exists OR was successfully seeded.
    const haveTarget = seedTemplateIfMissing(path)
    if (!haveTarget && requiresExisting) {
      for (const secret of envSecretNames) {
        result.skipped.push({
          secret,
          reason: `target config ${path} doesn't exist yet — run \`${entry.install.binary ?? entry.id}\` once to initialise it, then \`foreman secrets repush ${entry.id}\``,
        })
      }
    } else {
      const w = writeJsonEnvBlock(path, projection.json_env.section, envPairs)
      result.files.push({ path, secrets: envSecretNames, ...w })
    }
  }

  // -----------------------------------------------------------------------
  // 2) json_channels → nested deep-merge
  // -----------------------------------------------------------------------
  if (projection.json_channels) {
    const path = expand(projection.json_channels.path)
    const pairs: { dotPath: string; value: string; secret: string }[] = []
    for (const [, spec] of Object.entries(projection.json_channels.channels)) {
      if (!filterMatches(spec, ctx, entry.id)) continue
      const value = safeGet(ctx.secretStore, spec.from_secret, result.skipped)
      if (value === null) continue
      pairs.push({ dotPath: spec.path, value, secret: spec.from_secret })
    }
    if (pairs.length > 0) {
      // #385 — Same template-seed path as json_env.
      const haveTarget = seedTemplateIfMissing(path)
      if (!haveTarget && requiresExisting) {
        for (const p of pairs) {
          result.skipped.push({
            secret: p.secret,
            reason: `target config ${path} doesn't exist yet — run \`${entry.install.binary ?? entry.id}\` once to initialise it, then \`foreman secrets repush ${entry.id}\``,
          })
        }
      } else {
        const w = writeJsonChannels(path, pairs)
        result.files.push({ path, secrets: pairs.map((p) => p.secret), ...w })
      }
    }
  }

  // -----------------------------------------------------------------------
  // 3) toml_writes → flat key=value
  //    When the resolver won, it carries the agent's provider-related TOML
  //    writes (Codex `preferred_auth_method`, ZeroClaw `default_provider`).
  //    Legacy `toml_writes` block today has no `if_service` filter — every
  //    entry is provider-implicit — so the whole block stays gated. If a
  //    future agent adds a service-gated TOML write, refactor to per-entry
  //    gate (mirror the env_vars #425 pattern).
  // -----------------------------------------------------------------------
  if (
    projection.toml_writes &&
    projection.toml_writes.length > 0 &&
    !resolverWonProviderWrites
  ) {
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
  if (projection.auth_json && !resolverWonProviderWrites) {
    if (filterMatches(projection.auth_json, ctx, entry.id)) {
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

  // -----------------------------------------------------------------------
  // 5) config_overrides → per-provider YAML/JSON deep-merge (#389)
  // -----------------------------------------------------------------------
  // Solves the #350 root cause: Foreman projects env keys but the agent's
  // own config defaults to a different provider, so the keys never get
  // used. Hermes' template defaults to OpenRouter; if the user picked
  // openai we now write `model.provider: openai` + `model.default:
  // gpt-4o-mini` directly into ~/.hermes/config.yaml.
  if (projection.config_overrides) {
    const { path: rawPath, format, writes } = projection.config_overrides
    const path = expand(rawPath)
    const merged: Record<string, string | boolean | number | null> = {}
    for (const w of writes) {
      // #427 — Per-entry gate. The section used to be gated as a whole
      // by `!resolverWonProviderWrites`, which silently dropped every
      // `if_service` write (e.g. OpenClaw's `channels.telegram.dmPolicy`)
      // when the resolver path won. Same bug class as #425. Now: skip
      // ONLY provider-gated entries when the resolver owns provider
      // writes; service-gated writes (and chat-primary-gated ones) fire
      // regardless.
      if (resolverWonProviderWrites && w.if_provider) continue
      if (w.if_provider) {
        const matchesAgent = ctx.llmProvider === w.if_provider
        const matchesGlobal = ctx.providersSelected.includes(w.if_provider)
        if (!matchesAgent && !matchesGlobal) continue
      }
      if (w.if_service && !ctx.servicesSelected.includes(w.if_service)) {
        continue
      }
      // #426 — Skip channel-tied writes when this agent isn't the
      // configured primary for that channel.
      if (
        w.if_service &&
        ctx.chatPrimary &&
        !ctx.chatPrimary.isPrimary(w.if_service, entry.id)
      ) {
        continue
      }
      for (const [dot, value] of Object.entries(w.set)) {
        merged[dot] = value
      }
    }
    if (Object.keys(merged).length > 0) {
      try {
        const written = writeConfigOverrides(path, format, merged)
        result.files.push({
          path,
          // No secrets land in config_overrides — they stay in env_vars.
          secrets: [],
          ...written,
        })
      } catch (err) {
        result.skipped.push({
          secret: '(config_overrides)',
          reason: `failed to write ${path}: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }
  }

  // -----------------------------------------------------------------------
  // 6) security_bootstrap → gateway auth token + owner allowlist (#396)
  // -----------------------------------------------------------------------
  // OpenClaw's gateway refuses Telegram traffic without `gateway.auth.token`
  // AND `commands.ownerAllowFrom`. The token is generated once + preserved
  // across runs (clients would otherwise have to re-credentialize). The
  // owner allowlist is overwritten on every run with the current
  // `telegram-chat-id` value, formatted as `telegram:<chatId>`.
  if (projection.security_bootstrap) {
    const sb = projection.security_bootstrap
    const path = expand(sb.path)
    try {
      // Resolve token + allowlist values BEFORE we open the file so we
      // can skip the write entirely when neither side has anything to
      // contribute (avoids creating an empty file for an agent that
      // doesn't have the chat id yet).
      const authToken = sb.auth_token
        ? {
            key: sb.auth_token.key,
            generate: (): string =>
              encodeRandomBytes(sb.auth_token!.bytes, sb.auth_token!.encoding),
          }
        : undefined
      let ownerList: { keys: string[]; values: string[] } | undefined
      const secretsUsed: string[] = []
      if (sb.owner_allowlist) {
        const allowlistService = sb.owner_allowlist.if_service
        const matchesService =
          !allowlistService ||
          ctx.servicesSelected.includes(allowlistService)
        // #426 — Primary chat agent gate also covers the owner allowlist.
        // If a non-primary agent ran this projection, skip ownerAllowFrom
        // — only the agent that actually polls the channel gets to own
        // the allowlist.
        const primaryOk =
          !allowlistService ||
          !ctx.chatPrimary ||
          ctx.chatPrimary.isPrimary(allowlistService, entry.id)
        if (matchesService && primaryOk) {
          const value = safeGet(
            ctx.secretStore,
            sb.owner_allowlist.from_secret,
            result.skipped,
          )
          if (value !== null) {
            // #427 — `key` may be a single dot-path or an array of paths.
            // OpenClaw needs the same array projected to two slots so its
            // dmPolicy=allowlist validation passes.
            const keys = Array.isArray(sb.owner_allowlist.key)
              ? sb.owner_allowlist.key
              : [sb.owner_allowlist.key]
            ownerList = {
              keys,
              values: [
                sb.owner_allowlist.item_template.replace(/\{value\}/g, value),
              ],
            }
            secretsUsed.push(sb.owner_allowlist.from_secret)
          }
        }
      }
      if (authToken || ownerList) {
        const written = writeSecurityBootstrap(path, sb.format, {
          authToken,
          ownerAllowlist: ownerList,
        })
        result.files.push({ path, secrets: secretsUsed, ...written })
      }
    } catch (err) {
      result.skipped.push({
        secret: '(security_bootstrap)',
        reason: `failed to write ${path}: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  return result
}

function encodeRandomBytes(
  bytes: number,
  encoding: 'hex' | 'base64' | 'base64url',
): string {
  return randomBytes(bytes).toString(encoding)
}

// =============================================================================
// #408 / #410 Phase 2 — resolver-driven writes
// =============================================================================
//
// Applies a resolved `provider_mapping` configuration via the existing writer
// functions (writeDotenv / writeJsonEnvBlock / writeConfigOverrides / etc).
// The resolver already substituted `${model}` + `${secret:…}` templates, so
// these writes are concrete values ready to land on disk.
//
// File paths come from the agent's existing `secret_projection` block:
//   - env vars go to `secret_projection.env_file` or `json_env.path`
//   - configWrites go to `secret_projection.config_overrides.path` (or the
//     resolver's `writes` path inferred from registry — see #410 follow-up)
//   - tomlWrites carry their own `path` field
//   - authJsonWrites carry their own `path` field
function applyResolverWrites(
  entry: AgentEntry,
  resolved: ResolvedAgentProviderConfig,
  result: ProjectionResult,
  expand: (p: string) => string,
  seedTemplateIfMissing: (path: string) => boolean,
  requiresExisting: boolean,
  projection: NonNullable<AgentEntry['secret_projection']>,
): void {
  // ----- env vars -----
  const envPairs = resolved.envVars
  const envSecretNames = [resolved.requiredSecret].filter(
    (s): s is string => s !== null,
  )
  if (Object.keys(envPairs).length > 0) {
    if (projection.env_file) {
      const path = expand(projection.env_file)
      const w = writeDotenv(path, envPairs)
      result.files.push({ path, secrets: envSecretNames, ...w })
    }
    if (projection.json_env) {
      const path = expand(projection.json_env.path)
      const haveTarget = seedTemplateIfMissing(path)
      if (!haveTarget && requiresExisting) {
        for (const secret of envSecretNames) {
          result.skipped.push({
            secret,
            reason: `target config ${path} doesn't exist yet — run \`${entry.install.binary ?? entry.id}\` once to initialise it, then \`foreman secrets repush ${entry.id}\``,
          })
        }
      } else {
        const w = writeJsonEnvBlock(
          path,
          projection.json_env.section,
          envPairs,
        )
        result.files.push({ path, secrets: envSecretNames, ...w })
      }
    }
  }

  // ----- config writes (dot-paths into the agent's main config file) -----
  if (
    Object.keys(resolved.configWrites).length > 0 &&
    projection.config_overrides
  ) {
    const path = expand(projection.config_overrides.path)
    const format = projection.config_overrides.format
    try {
      const written = writeConfigOverrides(path, format, resolved.configWrites)
      result.files.push({ path, secrets: [], ...written })
    } catch (err) {
      result.skipped.push({
        secret: '(provider_mapping config writes)',
        reason: `failed to write ${path}: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  // ----- toml writes -----
  if (resolved.tomlWrites.length > 0) {
    const grouped = new Map<
      string,
      { key: string; value: string; secret: string | null }[]
    >()
    for (const w of resolved.tomlWrites) {
      const path = expand(w.path)
      const list = grouped.get(path) ?? []
      list.push({ key: w.key, value: w.value, secret: resolved.requiredSecret })
      grouped.set(path, list)
    }
    for (const [path, writes] of grouped.entries()) {
      const written = writeTomlFields(path, writes)
      result.files.push({
        path,
        secrets: writes
          .map((w) => w.secret)
          .filter((s): s is string => s !== null),
        ...written,
      })
    }
  }

  // ----- auth.json writes (Codex) -----
  for (const w of resolved.authJsonWrites) {
    const path = expand(w.path)
    const written = writeAuthJson(path, w.key, w.value)
    result.files.push({
      path,
      secrets: resolved.requiredSecret ? [resolved.requiredSecret] : [],
      ...written,
    })
  }
}

function filterMatches(
  spec: { if_provider?: string; if_service?: string },
  ctx: ProjectionContext,
  agentId: string,
): boolean {
  if (spec.if_provider && !ctx.providersSelected.includes(spec.if_provider)) {
    return false
  }
  if (spec.if_service) {
    if (!ctx.servicesSelected.includes(spec.if_service)) return false
    // #426 — Primary chat agent gate. When a primary is configured for
    // this service AND the current agent isn't it, drop the write.
    // ChatPrimaryService.isPrimary returns true when no primary is set
    // (legacy / un-picked state), so this is a no-op until the wizard or
    // CLI configures a primary explicitly.
    if (ctx.chatPrimary && !ctx.chatPrimary.isPrimary(spec.if_service, agentId)) {
      return false
    }
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
//  #389 — config_overrides writer
// =============================================================================

/**
 * Deep-merge dot-path values into a YAML or JSON config file. Preserves
 * every sibling key the user (or the agent's installer) put there.
 * Idempotent: writes only when the merged content differs.
 */
export function writeConfigOverrides(
  path: string,
  format: 'yaml' | 'json',
  dotPathValues: Record<string, string | boolean | number | null>,
): WriteOutcome {
  const exists = existsSync(path)
  let root: Record<string, unknown> = {}
  if (exists) {
    try {
      const raw = readFileSync(path, 'utf-8')
      const parsed =
        format === 'yaml' ? parseYaml(raw) : JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>
      }
    } catch {
      // Malformed input: start fresh. The user's broken file gets overwritten,
      // which is the lesser evil vs leaving the agent stranded.
    }
  }
  let replacedStale = false
  for (const [dotPath, value] of Object.entries(dotPathValues)) {
    const prev = readDotPath(root, dotPath)
    if (prev !== undefined && prev !== value) replacedStale = true
    writeDotPath(root, dotPath, value)
  }
  const serialized =
    format === 'yaml'
      ? stringifyYaml(root, { lineWidth: 120 })
      : JSON.stringify(root, null, 2) + '\n'
  atomicWrite0600(path, serialized)
  return { created: !exists, replacedStale }
}

// =============================================================================
//  #396 — security_bootstrap writer
// =============================================================================

/**
 * Write OpenClaw-style security fields (auth token + owner allowlist) into
 * the agent's JSON/YAML config. Auth-token rule: preserve any existing
 * non-empty string at the dot-path so clients of the gateway don't have
 * to be re-credentialized on every wizard re-run; only generate when
 * absent. Owner-allowlist rule: overwrite the array with the supplied
 * values on every run (deterministic given the same secret).
 */
export function writeSecurityBootstrap(
  path: string,
  format: 'yaml' | 'json',
  options: {
    authToken?: { key: string; generate: () => string }
    ownerAllowlist?: { keys: string[]; values: string[] }
  },
): WriteOutcome {
  const exists = existsSync(path)
  let root: Record<string, unknown> = {}
  if (exists) {
    try {
      const raw = readFileSync(path, 'utf-8')
      const parsed = format === 'yaml' ? parseYaml(raw) : JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>
      }
    } catch {
      // Malformed file → start fresh. The user's broken file gets
      // overwritten, which is the lesser evil vs leaving the gateway
      // refusing to start.
    }
  }
  let replacedStale = false
  if (options.authToken) {
    const existingToken = readDotPath(root, options.authToken.key)
    if (typeof existingToken !== 'string' || existingToken.length === 0) {
      writeDotPath(root, options.authToken.key, options.authToken.generate())
      // Newly-generated token isn't a stale-replacement — it's a fresh
      // fill. `replacedStale` stays false for that case.
    }
    // else: preserve existing — no write, no stale flag.
  }
  if (options.ownerAllowlist) {
    const next = options.ownerAllowlist.values
    // #427 — Project the same allowlist to every configured key. OpenClaw
    // needs both `commands.ownerAllowFrom` (command authorization) AND
    // `channels.telegram.allowFrom` (DM access — required when dmPolicy
    // is "allowlist") to point at the same user list.
    for (const key of options.ownerAllowlist.keys) {
      const prev = readDotPath(root, key)
      if (!Array.isArray(prev) || !arraysEqualShallow(prev, next)) {
        if (prev !== undefined) replacedStale = true
        writeDotPath(root, key, next)
      }
    }
  }
  const serialized =
    format === 'yaml'
      ? stringifyYaml(root, { lineWidth: 120 })
      : JSON.stringify(root, null, 2) + '\n'
  atomicWrite0600(path, serialized)
  return { created: !exists, replacedStale }
}

function arraysEqualShallow(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

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
