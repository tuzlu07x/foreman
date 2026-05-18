import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  projectSecretsForAgent,
  writeAuthJson,
  writeConfigOverrides,
  writeDotenv,
  writeJsonChannels,
  writeJsonEnvBlock,
  writeTomlFields,
} from '../../src/core/agent-secrets-projector.js'
import { parse as parseYaml } from 'yaml'
import type { AgentEntry } from '../../src/core/registry-catalog.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { createInMemoryDb, type ForemanDb } from '../../src/db/client.js'

function mode(p: string): string {
  return (statSync(p).mode & 0o777).toString(8)
}

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'foreman-projector-'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

// ===========================================================================
// Writers — unit tests
// ===========================================================================

describe('writeDotenv', () => {
  it('creates a fresh file with mode 0600', () => {
    const path = join(tmp, '.env')
    const out = writeDotenv(path, { ANTHROPIC_API_KEY: 'sk-ant-1' })
    expect(out.created).toBe(true)
    expect(out.replacedStale).toBe(false)
    expect(readFileSync(path, 'utf-8')).toBe('ANTHROPIC_API_KEY=sk-ant-1\n')
    expect(mode(path)).toBe('600')
  })

  it('preserves existing keys and comments, appends new ones', () => {
    const path = join(tmp, '.env')
    writeFileSync(path, '# user comment\nMY_OWN_KEY=keep\n', { mode: 0o600 })
    const out = writeDotenv(path, { ANTHROPIC_API_KEY: 'sk-ant-2' })
    expect(out.created).toBe(false)
    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('# user comment')
    expect(content).toContain('MY_OWN_KEY=keep')
    expect(content).toContain('ANTHROPIC_API_KEY=sk-ant-2')
  })

  it('replaces a stale duplicate key in place and reports replacedStale', () => {
    const path = join(tmp, '.env')
    writeFileSync(path, 'ANTHROPIC_API_KEY=old\n', { mode: 0o600 })
    const out = writeDotenv(path, { ANTHROPIC_API_KEY: 'new' })
    expect(out.replacedStale).toBe(true)
    expect(readFileSync(path, 'utf-8')).toContain('ANTHROPIC_API_KEY=new')
    expect(readFileSync(path, 'utf-8')).not.toContain('old')
  })

  it('quotes values that contain whitespace / # / quotes', () => {
    const path = join(tmp, '.env')
    writeDotenv(path, { MSG: 'hello world #1', QUOTED: 'it"s' })
    const text = readFileSync(path, 'utf-8')
    expect(text).toContain('MSG="hello world #1"')
    expect(text).toContain('QUOTED="it\\"s"')
  })
})

describe('writeJsonEnvBlock', () => {
  it('creates a fresh file with the env block at the requested section', () => {
    const path = join(tmp, 'settings.json')
    const out = writeJsonEnvBlock(path, 'env', { ANTHROPIC_API_KEY: 'sk-ant-3' })
    expect(out.created).toBe(true)
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    expect(parsed.env.ANTHROPIC_API_KEY).toBe('sk-ant-3')
    expect(mode(path)).toBe('600')
  })

  it('deep-merges into an existing settings.json without losing siblings', () => {
    const path = join(tmp, 'settings.json')
    writeFileSync(
      path,
      JSON.stringify({
        theme: 'dark',
        env: { EXISTING: 'keep' },
        mcpServers: { foreman: { command: 'node' } },
      }),
      { mode: 0o600 },
    )
    writeJsonEnvBlock(path, 'env', { ANTHROPIC_API_KEY: 'k' })
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    expect(parsed.theme).toBe('dark')
    expect(parsed.env.EXISTING).toBe('keep')
    expect(parsed.env.ANTHROPIC_API_KEY).toBe('k')
    expect(parsed.mcpServers.foreman.command).toBe('node')
  })

  it('flags replacedStale when overwriting a different value', () => {
    const path = join(tmp, 'settings.json')
    writeFileSync(path, JSON.stringify({ env: { K: 'old' } }), { mode: 0o600 })
    const out = writeJsonEnvBlock(path, 'env', { K: 'new' })
    expect(out.replacedStale).toBe(true)
  })

  it('does not flag replacedStale when the value is unchanged', () => {
    const path = join(tmp, 'settings.json')
    writeFileSync(path, JSON.stringify({ env: { K: 'same' } }), { mode: 0o600 })
    const out = writeJsonEnvBlock(path, 'env', { K: 'same' })
    expect(out.replacedStale).toBe(false)
  })

  it('starts fresh when the existing JSON is malformed (does not crash)', () => {
    const path = join(tmp, 'settings.json')
    writeFileSync(path, '{not valid json', { mode: 0o600 })
    const out = writeJsonEnvBlock(path, 'env', { K: 'v' })
    expect(out.created).toBe(false)
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    expect(parsed.env.K).toBe('v')
  })
})

describe('writeJsonChannels', () => {
  it('writes nested dot-paths and preserves siblings', () => {
    const path = join(tmp, 'openclaw.json')
    writeFileSync(
      path,
      JSON.stringify({
        env: { ANTHROPIC_API_KEY: 'x' },
        channels: { discord: { token: 'd-token' } },
      }),
      { mode: 0o600 },
    )
    writeJsonChannels(path, [
      { dotPath: 'channels.telegram.botToken', value: 't-token' },
      { dotPath: 'channels.slack.botToken', value: 's-token' },
    ])
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    expect(parsed.env.ANTHROPIC_API_KEY).toBe('x')
    expect(parsed.channels.discord.token).toBe('d-token')
    expect(parsed.channels.telegram.botToken).toBe('t-token')
    expect(parsed.channels.slack.botToken).toBe('s-token')
  })
})

describe('writeTomlFields', () => {
  it('appends fresh top-level keys to an empty file', () => {
    const path = join(tmp, 'config.toml')
    const out = writeTomlFields(path, [
      { key: 'default_provider', value: 'anthropic' },
      { key: 'api_key', value: 'sk-ant-x' },
    ])
    expect(out.created).toBe(true)
    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('default_provider = "anthropic"')
    expect(content).toContain('api_key = "sk-ant-x"')
  })

  it('replaces a stale top-level key in place and preserves siblings', () => {
    const path = join(tmp, 'config.toml')
    writeFileSync(
      path,
      'other = "keep"\napi_key = "old"\n\n[server]\nport = 8080\n',
      { mode: 0o600 },
    )
    const out = writeTomlFields(path, [{ key: 'api_key', value: 'new' }])
    expect(out.replacedStale).toBe(true)
    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('other = "keep"')
    expect(content).toContain('api_key = "new"')
    expect(content).toContain('[server]')
    expect(content).toContain('port = 8080')
  })

  it('inserts new keys BEFORE the first table header so they stay at top-level', () => {
    const path = join(tmp, 'config.toml')
    writeFileSync(path, '[server]\nport = 8080\n', { mode: 0o600 })
    writeTomlFields(path, [{ key: 'api_key', value: 'sk' }])
    const content = readFileSync(path, 'utf-8')
    const apiIdx = content.indexOf('api_key')
    const serverIdx = content.indexOf('[server]')
    expect(apiIdx).toBeLessThan(serverIdx)
  })

  it('escapes backslash and double-quote in the value', () => {
    const path = join(tmp, 'config.toml')
    writeTomlFields(path, [{ key: 'k', value: 'a\\b"c' }])
    expect(readFileSync(path, 'utf-8')).toContain('k = "a\\\\b\\"c"')
  })
})

describe('writeAuthJson', () => {
  it('writes a flat JSON map at mode 0600', () => {
    const path = join(tmp, 'auth.json')
    const out = writeAuthJson(path, 'OPENAI_API_KEY', 'sk-1')
    expect(out.created).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ OPENAI_API_KEY: 'sk-1' })
    expect(mode(path)).toBe('600')
  })

  it('preserves sibling keys when updating', () => {
    const path = join(tmp, 'auth.json')
    writeFileSync(path, JSON.stringify({ OTHER: 'keep' }), { mode: 0o600 })
    writeAuthJson(path, 'OPENAI_API_KEY', 'sk-2')
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    expect(parsed.OTHER).toBe('keep')
    expect(parsed.OPENAI_API_KEY).toBe('sk-2')
  })
})

// ===========================================================================
// projectSecretsForAgent — integration
// ===========================================================================

function fakeEntry(over: Partial<AgentEntry> = {}): AgentEntry {
  return {
    id: 'hermes',
    name: 'Hermes',
    tagline: 'Test',
    homepage: 'https://example.com',
    install: { npm: null, brew: null },
    config_paths: [],
    required_secrets: [],
    optional_secrets: [],
    llm_compat: [],
    optional_services: [],
    mcp_compatible: true,
    supported_versions: '*',
    min_foreman_version: '0.1.2',
    ...over,
  } as AgentEntry
}

describe('projectSecretsForAgent — wiring', () => {
  let db: ForemanDb
  let sqlite: ReturnType<typeof createInMemoryDb>['sqlite']
  let store: SecretStore
  beforeEach(() => {
    const h = createInMemoryDb()
    db = h.db
    sqlite = h.sqlite
    store = new SecretStore(db, Buffer.alloc(32, 1))
    store.add('anthropic-key', 'sk-ant-1')
    store.add('telegram-bot-token', '123:abc')
    store.add('openai-key', 'sk-oa-1')
  })
  afterEach(() => { sqlite.close() })

  it('writes dotenv when env_file + env_vars match the user selection', () => {
    const entry = fakeEntry({
      secret_projection: {
        env_file: `${tmp}/.env`,
        env_vars: {
          ANTHROPIC_API_KEY: { from_secret: 'anthropic-key', if_provider: 'anthropic' },
          OPENAI_API_KEY: { from_secret: 'openai-key', if_provider: 'openai' },
        },
      },
    })
    const result = projectSecretsForAgent(entry, {
      providersSelected: ['anthropic'],
      servicesSelected: [],
      secretStore: store,
      home: tmp,
    })
    expect(result.files).toHaveLength(1)
    const env = readFileSync(`${tmp}/.env`, 'utf-8')
    expect(env).toContain('ANTHROPIC_API_KEY=sk-ant-1')
    expect(env).not.toContain('OPENAI_API_KEY')
  })

  it('filters env_vars by if_service against servicesSelected', () => {
    const entry = fakeEntry({
      secret_projection: {
        env_file: `${tmp}/.env`,
        env_vars: {
          TELEGRAM_BOT_TOKEN: { from_secret: 'telegram-bot-token', if_service: 'telegram' },
        },
      },
    })
    const noServiceResult = projectSecretsForAgent(entry, {
      providersSelected: [],
      servicesSelected: [],
      secretStore: store,
      home: tmp,
    })
    expect(noServiceResult.files).toHaveLength(0)

    const withResult = projectSecretsForAgent(entry, {
      providersSelected: [],
      servicesSelected: ['telegram'],
      secretStore: store,
      home: tmp,
    })
    expect(withResult.files).toHaveLength(1)
    expect(readFileSync(`${tmp}/.env`, 'utf-8')).toContain('TELEGRAM_BOT_TOKEN=123:abc')
  })

  it('reports skipped secrets when the store does not have them', () => {
    const entry = fakeEntry({
      secret_projection: {
        env_file: `${tmp}/.env`,
        env_vars: {
          MISSING_KEY: { from_secret: 'never-added' },
        },
      },
    })
    const result = projectSecretsForAgent(entry, {
      providersSelected: [],
      servicesSelected: [],
      secretStore: store,
      home: tmp,
    })
    expect(result.files).toHaveLength(0)
    expect(result.skipped).toEqual([
      { secret: 'never-added', reason: 'not in secret store' },
    ])
  })

  it('dispatches to writeJsonEnvBlock when json_env is set', () => {
    const entry = fakeEntry({
      secret_projection: {
        json_env: { path: `${tmp}/settings.json`, section: 'env' },
        env_vars: {
          ANTHROPIC_API_KEY: { from_secret: 'anthropic-key', if_provider: 'anthropic' },
        },
      },
    })
    projectSecretsForAgent(entry, {
      providersSelected: ['anthropic'],
      servicesSelected: [],
      secretStore: store,
      home: tmp,
    })
    const parsed = JSON.parse(readFileSync(`${tmp}/settings.json`, 'utf-8'))
    expect(parsed.env.ANTHROPIC_API_KEY).toBe('sk-ant-1')
  })

  it('dispatches to writeJsonChannels when json_channels is set', () => {
    const entry = fakeEntry({
      secret_projection: {
        json_channels: {
          path: `${tmp}/openclaw.json`,
          channels: {
            telegram: {
              path: 'channels.telegram.botToken',
              from_secret: 'telegram-bot-token',
              if_service: 'telegram',
            },
          },
        },
      },
    })
    projectSecretsForAgent(entry, {
      providersSelected: [],
      servicesSelected: ['telegram'],
      secretStore: store,
      home: tmp,
    })
    const parsed = JSON.parse(readFileSync(`${tmp}/openclaw.json`, 'utf-8'))
    expect(parsed.channels.telegram.botToken).toBe('123:abc')
  })

  it('dispatches to writeTomlFields + auth_json (Codex pattern)', () => {
    const entry = fakeEntry({
      secret_projection: {
        toml_writes: [
          { path: `${tmp}/config.toml`, key: 'preferred_auth_method', value: 'apikey' },
        ],
        auth_json: {
          path: `${tmp}/auth.json`,
          key: 'OPENAI_API_KEY',
          from_secret: 'openai-key',
          if_provider: 'openai',
        },
      },
    })
    projectSecretsForAgent(entry, {
      providersSelected: ['openai'],
      servicesSelected: [],
      secretStore: store,
      home: tmp,
    })
    expect(readFileSync(`${tmp}/config.toml`, 'utf-8')).toContain(
      'preferred_auth_method = "apikey"',
    )
    expect(JSON.parse(readFileSync(`${tmp}/auth.json`, 'utf-8'))).toEqual({
      OPENAI_API_KEY: 'sk-oa-1',
    })
  })

  it('toml_writes with a from_secret reference picks the secret value', () => {
    const entry = fakeEntry({
      secret_projection: {
        toml_writes: [
          { path: `${tmp}/zc.toml`, key: 'default_provider', value: 'anthropic' },
          { path: `${tmp}/zc.toml`, key: 'api_key', value: { from_secret: 'anthropic-key' } },
        ],
      },
    })
    projectSecretsForAgent(entry, {
      providersSelected: [],
      servicesSelected: [],
      secretStore: store,
      home: tmp,
    })
    const content = readFileSync(`${tmp}/zc.toml`, 'utf-8')
    expect(content).toContain('default_provider = "anthropic"')
    expect(content).toContain('api_key = "sk-ant-1"')
  })

  it('returns an empty result when the entry has no secret_projection block', () => {
    const result = projectSecretsForAgent(fakeEntry({ secret_projection: undefined }), {
      providersSelected: [],
      servicesSelected: [],
      secretStore: store,
      home: tmp,
    })
    expect(result.files).toEqual([])
    expect(result.skipped).toEqual([])
  })

  // #377 — Agents (OpenClaw) whose binary refuses a stripped-down JSON
  // must wait for the user to init their own config first.
  describe('install.requires_existing_config (#377)', () => {
    it('skips json_env when target file is missing AND requires_existing_config:true', () => {
      const path = `${tmp}/openclaw.json`
      const entry = fakeEntry({
        install: {
          npm: null,
          brew: null,
          binary: 'openclaw',
          requires_existing_config: true,
        },
        secret_projection: {
          json_env: { path, section: 'env' },
          env_vars: {
            OPENAI_API_KEY: { from_secret: 'openai-key', if_provider: 'openai' },
          },
        },
      })
      const result = projectSecretsForAgent(entry, {
        providersSelected: ['openai'],
        servicesSelected: [],
        secretStore: store,
        home: tmp,
      })
      expect(result.files).toHaveLength(0)
      expect(result.skipped).toHaveLength(1)
      expect(result.skipped[0]?.reason).toMatch(/doesn't exist/)
      expect(result.skipped[0]?.reason).toContain('openclaw')
      expect(existsSync(path)).toBe(false)
    })

    it('writes normally when target file already exists', () => {
      const path = `${tmp}/openclaw.json`
      writeFileSync(path, JSON.stringify({ defaultAgent: 'main', agents: {} }))
      const entry = fakeEntry({
        install: {
          npm: null,
          brew: null,
          binary: 'openclaw',
          requires_existing_config: true,
        },
        secret_projection: {
          json_env: { path, section: 'env' },
          env_vars: {
            OPENAI_API_KEY: { from_secret: 'openai-key', if_provider: 'openai' },
          },
        },
      })
      const result = projectSecretsForAgent(entry, {
        providersSelected: ['openai'],
        servicesSelected: [],
        secretStore: store,
        home: tmp,
      })
      expect(result.files).toHaveLength(1)
      const parsed = JSON.parse(readFileSync(path, 'utf-8'))
      // Preserves existing defaultAgent
      expect(parsed.defaultAgent).toBe('main')
      // Adds env section
      expect(parsed.env.OPENAI_API_KEY).toBe('sk-oa-1')
    })

    it('skips json_channels too when file missing + flag true', () => {
      const path = `${tmp}/openclaw.json`
      const entry = fakeEntry({
        install: {
          npm: null,
          brew: null,
          binary: 'openclaw',
          requires_existing_config: true,
        },
        secret_projection: {
          json_channels: {
            path,
            channels: {
              telegram: {
                path: 'channels.telegram.botToken',
                from_secret: 'telegram-bot-token',
                if_service: 'telegram',
              },
            },
          },
        },
      })
      const result = projectSecretsForAgent(entry, {
        providersSelected: [],
        servicesSelected: ['telegram'],
        secretStore: store,
        home: tmp,
      })
      expect(result.files).toHaveLength(0)
      expect(result.skipped).toHaveLength(1)
      expect(result.skipped[0]?.reason).toMatch(/doesn't exist/)
      expect(existsSync(path)).toBe(false)
    })

    it('creates the file when requires_existing_config:false / undefined (default)', () => {
      const path = `${tmp}/hermes-settings.json`
      const entry = fakeEntry({
        install: { npm: null, brew: null }, // no requires_existing_config
        secret_projection: {
          json_env: { path, section: 'env' },
          env_vars: {
            OPENAI_API_KEY: { from_secret: 'openai-key', if_provider: 'openai' },
          },
        },
      })
      const result = projectSecretsForAgent(entry, {
        providersSelected: ['openai'],
        servicesSelected: [],
        secretStore: store,
        home: tmp,
      })
      expect(result.files).toHaveLength(1)
      expect(existsSync(path)).toBe(true)
    })

    // #385 — When config_template_path is set + file missing, projector
    // seeds the bundled template before overlaying keys. Replaces the
    // manual "openclaw onboard → repush" dance.
    it('seeds from bundled template when file missing + template path set (#385)', () => {
      // Use the real bundled openclaw.json template — verifies the
      // resolveBundledTemplatePath path actually resolves in a test env.
      const targetPath = `${tmp}/openclaw.json`
      const entry = fakeEntry({
        install: {
          npm: null,
          brew: null,
          binary: 'openclaw',
          // requires_existing_config NOT set — template eliminates the need
          config_template_path: 'registry/templates/openclaw.json',
        },
        secret_projection: {
          json_env: { path: targetPath, section: 'env' },
          env_vars: {
            OPENAI_API_KEY: { from_secret: 'openai-key', if_provider: 'openai' },
          },
        },
      })
      const result = projectSecretsForAgent(entry, {
        providersSelected: ['openai'],
        servicesSelected: [],
        secretStore: store,
        home: tmp,
      })
      expect(existsSync(targetPath)).toBe(true)
      expect(result.files).toHaveLength(1)
      const parsed = JSON.parse(readFileSync(targetPath, 'utf-8'))
      // Template's `agents.defaults.workspace` should be preserved
      expect(parsed.agents.defaults.workspace).toContain('.openclaw/workspace')
      // ~/ in template gets expanded to the home arg's path
      expect(parsed.agents.defaults.workspace.startsWith(tmp)).toBe(true)
      // Foreman overlays env section
      expect(parsed.env.OPENAI_API_KEY).toBe('sk-oa-1')
      // Template's other top-level fields stay intact
      expect(parsed.mcp.servers).toEqual({})
      expect(parsed.channels).toEqual({})
      expect(parsed.gateway.mode).toBe('local')
    })

    it('skips seeding when template path is set but template is missing', () => {
      const targetPath = `${tmp}/missing-template.json`
      const entry = fakeEntry({
        install: {
          npm: null,
          brew: null,
          binary: 'missing-agent',
          requires_existing_config: true,
          config_template_path: 'registry/templates/nonexistent.json',
        },
        secret_projection: {
          json_env: { path: targetPath, section: 'env' },
          env_vars: {
            OPENAI_API_KEY: { from_secret: 'openai-key', if_provider: 'openai' },
          },
        },
      })
      const result = projectSecretsForAgent(entry, {
        providersSelected: ['openai'],
        servicesSelected: [],
        secretStore: store,
        home: tmp,
      })
      // Template missing → seed fails → requires_existing_config kicks in → skip
      expect(existsSync(targetPath)).toBe(false)
      expect(result.files).toHaveLength(0)
      expect(result.skipped).toHaveLength(1)
      expect(result.skipped[0]?.reason).toMatch(/doesn't exist/)
    })

    it('env_file (dotenv) is always created regardless of flag — agents that need this rely on it', () => {
      // dotenv is just key=value; no schema risk. Hermes' .env etc.
      const path = `${tmp}/.env`
      const entry = fakeEntry({
        install: {
          npm: null,
          brew: null,
          requires_existing_config: true,
        },
        secret_projection: {
          env_file: path,
          env_vars: {
            ANTHROPIC_API_KEY: {
              from_secret: 'anthropic-key',
              if_provider: 'anthropic',
            },
          },
        },
      })
      const result = projectSecretsForAgent(entry, {
        providersSelected: ['anthropic'],
        servicesSelected: [],
        secretStore: store,
        home: tmp,
      })
      expect(result.files).toHaveLength(1)
      expect(existsSync(path)).toBe(true)
    })
  })
})

// #389 — config_overrides writer + per-provider projection logic. Solves
// the Hermes/OpenClaw "config.yaml provider stays at template default"
// problem (was Option B from #350).
describe('writeConfigOverrides (#389)', () => {
  it('creates a fresh YAML file with the dot-path values', () => {
    const path = join(tmp, 'config.yaml')
    const out = writeConfigOverrides(path, 'yaml', {
      'model.default': 'openai/gpt-4o-mini',
      'model.provider': 'openai',
    })
    expect(out.created).toBe(true)
    expect(out.replacedStale).toBe(false)
    const parsed = parseYaml(readFileSync(path, 'utf-8')) as Record<
      string,
      unknown
    >
    expect((parsed.model as { default: string }).default).toBe(
      'openai/gpt-4o-mini',
    )
    expect((parsed.model as { provider: string }).provider).toBe('openai')
  })

  it('overlays into existing YAML preserving siblings', () => {
    // #397 — Hermes' model.default uses slash-form "<provider>/<model>" per
    // docs (https://hermes-agent.nousresearch.com/docs/user-guide/configuring-models).
    const path = join(tmp, 'hermes.yaml')
    writeFileSync(
      path,
      'model:\n  default: anthropic/claude\n  provider: auto\nterminal:\n  backend: local\n',
      { mode: 0o600 },
    )
    const out = writeConfigOverrides(path, 'yaml', {
      'model.default': 'openai/gpt-4o-mini',
      'model.provider': 'openai',
      'model.base_url': 'https://api.openai.com/v1',
    })
    expect(out.created).toBe(false)
    expect(out.replacedStale).toBe(true)
    const parsed = parseYaml(readFileSync(path, 'utf-8')) as {
      model: { default: string; provider: string; base_url: string }
      terminal: { backend: string }
    }
    expect(parsed.model.default).toBe('openai/gpt-4o-mini')
    expect(parsed.model.provider).toBe('openai')
    expect(parsed.model.base_url).toBe('https://api.openai.com/v1')
    // Sibling top-level keys survive
    expect(parsed.terminal.backend).toBe('local')
  })

  it('overlays into JSON files too — OpenClaw canonical nested model shape', () => {
    // #395 — OpenClaw's schema requires `agents.defaults.model.primary`
    // (object) carrying a slash-form `<provider>/<model>` value. The bare
    // `agents.defaults.model: "gpt-4o-mini"` shape produces a doctor
    // fallback warning, and `agents.defaults.provider` is a rejected key.
    const path = join(tmp, 'openclaw.json')
    writeFileSync(
      path,
      JSON.stringify({
        agents: { defaults: { workspace: '~/.openclaw' } },
        channels: { telegram: { token: 'tok' } },
      }),
      { mode: 0o600 },
    )
    const out = writeConfigOverrides(path, 'json', {
      'agents.defaults.model.primary': 'openai/gpt-4o-mini',
    })
    expect(out.created).toBe(false)
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    expect(parsed.agents.defaults.model.primary).toBe('openai/gpt-4o-mini')
    // Existing keys preserved
    expect(parsed.agents.defaults.workspace).toBe('~/.openclaw')
    expect(parsed.channels.telegram.token).toBe('tok')
    // No leftover `provider` field — registry no longer writes it
    expect(parsed.agents.defaults.provider).toBeUndefined()
  })

  it('starts fresh on malformed YAML (no crash)', () => {
    const path = join(tmp, 'broken.yaml')
    writeFileSync(path, ':\n  invalid: [not yaml at all', { mode: 0o600 })
    const out = writeConfigOverrides(path, 'yaml', {
      'model.provider': 'openai',
    })
    expect(out.created).toBe(false)
    const parsed = parseYaml(readFileSync(path, 'utf-8')) as Record<
      string,
      unknown
    >
    expect((parsed.model as { provider: string }).provider).toBe('openai')
  })
})

describe('projectSecretsForAgent — config_overrides (#389)', () => {
  let db: ForemanDb
  let sqlite: ReturnType<typeof createInMemoryDb>['sqlite']
  let store: SecretStore

  beforeEach(() => {
    const h = createInMemoryDb()
    db = h.db
    sqlite = h.sqlite
    store = new SecretStore(db, Buffer.alloc(32, 1))
  })
  afterEach(() => {
    sqlite.close()
  })

  function hermesEntry(): AgentEntry {
    return {
      id: 'hermes',
      name: 'Hermes',
      tagline: 't',
      homepage: 'https://example.com',
      install: { npm: null, brew: null },
      config_paths: [],
      required_secrets: [],
      optional_secrets: [],
      mcp_compatible: true,
      supported_versions: '*',
      min_foreman_version: '0.1.2',
      secret_projection: {
        config_overrides: {
          path: `${tmp}/hermes.yaml`,
          format: 'yaml',
          writes: [
            {
              if_provider: 'openai',
              set: {
                'model.default': 'openai/gpt-4o-mini',
                'model.provider': 'openai',
              },
            },
            {
              if_provider: 'anthropic',
              set: {
                'model.default': 'anthropic/claude-haiku-4-5-20251001',
                'model.provider': 'anthropic',
              },
            },
          ],
        },
      },
    } as AgentEntry
  }

  it('writes the openai overrides when llmProvider=openai', () => {
    const result = projectSecretsForAgent(hermesEntry(), {
      providersSelected: ['openai'],
      servicesSelected: [],
      llmProvider: 'openai',
      secretStore: store,
      home: tmp,
    })
    expect(result.files).toHaveLength(1)
    const parsed = parseYaml(readFileSync(`${tmp}/hermes.yaml`, 'utf-8')) as {
      model: { default: string; provider: string }
    }
    expect(parsed.model.provider).toBe('openai')
    expect(parsed.model.default).toBe('openai/gpt-4o-mini')
  })

  it('writes the anthropic overrides when llmProvider=anthropic', () => {
    const result = projectSecretsForAgent(hermesEntry(), {
      providersSelected: ['openai', 'anthropic'],
      servicesSelected: [],
      llmProvider: 'anthropic',
      secretStore: store,
      home: tmp,
    })
    expect(result.files).toHaveLength(1)
    const parsed = parseYaml(readFileSync(`${tmp}/hermes.yaml`, 'utf-8')) as {
      model: { provider: string }
    }
    expect(parsed.model.provider).toBe('anthropic')
  })

  it('writes nothing when no llmProvider is set and no global match', () => {
    const result = projectSecretsForAgent(hermesEntry(), {
      providersSelected: [], // no global match either
      servicesSelected: [],
      secretStore: store,
      home: tmp,
    })
    expect(result.files).toHaveLength(0)
    expect(existsSync(`${tmp}/hermes.yaml`)).toBe(false)
  })

  it('falls back to providersSelected when llmProvider omitted (back-compat)', () => {
    const result = projectSecretsForAgent(hermesEntry(), {
      providersSelected: ['openai'],
      servicesSelected: [],
      // no llmProvider
      secretStore: store,
      home: tmp,
    })
    expect(result.files).toHaveLength(1)
    const parsed = parseYaml(readFileSync(`${tmp}/hermes.yaml`, 'utf-8')) as {
      model: { provider: string }
    }
    expect(parsed.model.provider).toBe('openai')
  })

  it('preserves siblings the user added to the YAML file', () => {
    writeFileSync(
      `${tmp}/hermes.yaml`,
      'model:\n  default: anthropic/claude\n  provider: auto\nterminal:\n  backend: docker\n',
      { mode: 0o600 },
    )
    projectSecretsForAgent(hermesEntry(), {
      providersSelected: ['openai'],
      servicesSelected: [],
      llmProvider: 'openai',
      secretStore: store,
      home: tmp,
    })
    const parsed = parseYaml(readFileSync(`${tmp}/hermes.yaml`, 'utf-8')) as {
      model: { provider: string; default: string }
      terminal: { backend: string }
    }
    expect(parsed.model.provider).toBe('openai')
    expect(parsed.model.default).toBe('openai/gpt-4o-mini')
    expect(parsed.terminal.backend).toBe('docker') // user-added survives
  })
})
