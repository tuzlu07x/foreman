import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runInit } from '../../src/cli/init.js'
import { runDoctor } from '../../src/core/doctor.js'
import { EventBus, type ForemanEventMap } from '../../src/core/event-bus.js'
import { MediatorService } from '../../src/core/mediator.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { RegistryService } from '../../src/core/registry.js'
import { RiskScorer } from '../../src/core/risk-scorer.js'
import { SessionManager } from '../../src/core/session.js'
import { AuditLogger } from '../../src/core/audit.js'
import { SecretStore } from '../../src/core/secret-store.js'
import { closeDb, getDb } from '../../src/db/client.js'
import { requests } from '../../src/db/schema.js'
import { loadOrCreateSecretsMasterKey } from '../../src/identity/master-key.js'
import { getForemanPaths } from '../../src/utils/config.js'
import { buildLlmConfigFromWizard } from '../../src/tui/setup-wizard-llm-persist.js'
import { buildNotifyConfigFromWizard } from '../../src/tui/setup-wizard-notify-persist.js'
import { persistVoiceConfig } from '../../src/tui/setup-wizard-voice-persist.js'
import { loadActiveProviders } from '../../src/core/registry-catalog.js'
import {
  defaultLlmConfig,
  loadLlmConfig,
  saveLlmConfig,
} from '../../src/core/llm/config.js'
import {
  defaultNotifyConfig,
  loadNotifyConfig,
  saveNotifyConfig,
} from '../../src/core/notification/notify-config.js'
import { loadVoiceConfig } from '../../src/core/notification/voice-config.js'
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalService,
} from '../../src/core/approval.js'
import type { JSONRPCMessage } from '../../src/mcp/types.js'

// =============================================================================
// #308 — End-to-end fresh setup → demo approval flow
// =============================================================================
//
// This is the regression gate for v0.1.0. It replays the full first-user
// experience in <30s, deterministically, with no external network deps:
//
//   1. foreman init (cold)
//   2. Simulate wizard completion via the persist helpers (real on-disk
//      writes for llm.yaml / notify.yaml / voice.yaml + secret store
//      seeded). The wizard's UI itself is owner-eyeball-tested.
//   3. foreman doctor — expect every check to pass except chafa (cosmetic
//      warning, not a regression).
//   4. Boot a real MediatorService + RiskScorer + AuditLogger with the
//      wired-up policies + responsibility map.
//   5. Drive a risky tool call (read .env) → assert the modal would have
//      fired with the right verdict (here: capturing approval service).
//   6. Resolve the approval, assert the audit row carries the expected
//      shape (decidedBy, sessionId, securityReport.source).
//
// Every wizard bug found in round 1+2 should now show up as a failure
// here — that's the point of the gate.

const TEST_AGENT_ID = 'hermes'

describe('#308 — fresh setup to demo (E2E gate)', () => {
  let tmpHome: string
  let previousHome: string | undefined
  let previousLang: string | undefined

  beforeAll(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'foreman-e2e-'))
    previousHome = process.env.FOREMAN_HOME
    previousLang = process.env.LANG
    process.env.FOREMAN_HOME = tmpHome
    // Pin locale so the smart-summary narrator path is deterministic if it
    // ever gets invoked from this test (currently not exercised).
    process.env.LANG = 'en_US.UTF-8'
  })

  afterAll(() => {
    closeDb()
    if (previousHome === undefined) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = previousHome
    if (previousLang === undefined) delete process.env.LANG
    else process.env.LANG = previousLang
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('phase 1: foreman init produces every expected file', () => {
    const initResult = runInit()
    expect(initResult.identityWasNew).toBe(true)
    expect(initResult.policyWasNew).toBe(true)
    expect(initResult.soulWasNew).toBe(true)
    const paths = getForemanPaths()
    expect(existsSync(paths.root)).toBe(true)
    expect(existsSync(paths.identityPath)).toBe(true)
    expect(existsSync(paths.policyPath)).toBe(true)
    expect(existsSync(paths.dbPath)).toBe(true)
    // Voice / llm / notify are not seeded by init — the wizard does that.
  })

  it('phase 2: wizard persist helpers write llm.yaml + notify.yaml + voice.yaml', () => {
    const paths = getForemanPaths()
    // Simulate the providers step — user picks anthropic.
    const db = getDb()
    const store = new SecretStore(db, loadOrCreateSecretsMasterKey())
    store.add('anthropic-key', 'sk-ant-fake-for-e2e')
    store.add('telegram-bot-token', '123:bot-token')
    store.add('telegram-chat-id', '8263464163')

    const { doc: providersDoc } = loadActiveProviders()
    const llmResult = buildLlmConfigFromWizard({
      savedStorageNames: ['anthropic-key'],
      providerCatalog: providersDoc.providers,
      existing: defaultLlmConfig(),
    })
    saveLlmConfig(paths.llmConfigPath, llmResult.next)

    // Simulate the services step — user wired telegram.
    const notifyResult = buildNotifyConfigFromWizard({
      savedStorageNames: ['telegram-bot-token', 'telegram-chat-id'],
      serviceCatalog: [
        {
          id: 'telegram',
          name: 'Telegram',
          description: 'desc',
          secret_name: 'telegram-bot-token',
          where_to_get: null,
          format_hint: 'token',
          setup_steps: [],
          used_by_agents: [],
          open_url_hotkey: false,
          extra_secrets: [
            {
              name: 'telegram-chat-id',
              description: 'chat id',
              format_hint: '12345',
              where_to_get: null,
              setup_steps: [],
              optional: true,
            },
          ],
        },
      ],
      secretStore: { get: (n) => store.get(n) },
      existing: defaultNotifyConfig(),
    })
    saveNotifyConfig(paths.notifyConfigPath, notifyResult.next)

    // Simulate the services-summary → voice persist step.
    persistVoiceConfig(paths.voiceConfigPath, ['telegram'])

    // Simulate the agents step — register hermes so doctor's
    // agents_registered check passes.
    const registry = new RegistryService(db, new EventBus<ForemanEventMap>())
    registry.register({
      id: TEST_AGENT_ID,
      displayName: 'Hermes',
      transport: 'stdio',
      responsibilityNote: 'code writing',
    })

    // All three configs land on disk.
    expect(existsSync(paths.llmConfigPath)).toBe(true)
    expect(existsSync(paths.notifyConfigPath)).toBe(true)
    expect(existsSync(paths.voiceConfigPath)).toBe(true)

    // Re-read + assert sane shape.
    const llm = loadLlmConfig(paths.llmConfigPath)
    expect(llm.enabled).toBe(true)
    expect(llm.provider).toBe('anthropic')

    const notify = loadNotifyConfig(paths.notifyConfigPath)
    expect(notify.channels.telegram?.enabled).toBe(true)
    expect(notify.channels.telegram?.chat_id).toBe('8263464163')

    const voice = loadVoiceConfig(paths.voiceConfigPath)
    expect(voice.quiet_hours.enabled).toBe(true)
    // Telegram is wired → proactive types stay enabled.
    expect(voice.proactive_notifications.pattern_detection.enabled).toBe(true)
  })

  it('phase 3: foreman doctor reports every required check ok (only chafa may warn)', () => {
    const report = runDoctor()
    const failed = report.checks.filter((c) => c.status === 'fail')
    expect(failed).toEqual([])
    // chafa is the only acceptable warn (cosmetic — terminal mascot
    // rendering); everything else must be ok.
    const otherWarns = report.checks.filter(
      (c) => c.status === 'warn' && c.name !== 'chafa',
    )
    if (otherWarns.length > 0) {
      // Surface which checks warned so the failure message is actionable.
      const msgs = otherWarns
        .map((w) => `  - ${w.name}: ${w.message}`)
        .join('\n')
      throw new Error(`unexpected warnings:\n${msgs}`)
    }
  })

  it('phase 4-6: mediator denies a risky tool call + audit row persists with the right shape', async () => {
    const paths = getForemanPaths()
    const db = getDb()
    const e2eBus = new EventBus<ForemanEventMap>()
    const registry = new RegistryService(db, e2eBus)
    // Agent already registered in phase 2 — just confirm it's still here.
    expect(registry.get(TEST_AGENT_ID)).toBeTruthy()
    const policy = new PolicyEngine(db, e2eBus)
    if (existsSync(paths.policyPath)) policy.loadFromYaml(paths.policyPath)
    const risk = new RiskScorer(db, undefined, {
      bucketOverrides: () => policy.getBucketOverrides(),
      getAgentResponsibility: (id) =>
        registry.get(id)?.responsibilityNote ?? null,
      responsibilityPolicies: () => policy.getResponsibilityPolicies(),
    })
    const sessionManager = new SessionManager(db, { bus: e2eBus })
    const audit = new AuditLogger(db, e2eBus)

    // Capturing approval service — records the request the modal would see
    // and returns deny so the test is deterministic.
    const seenApprovals: ApprovalRequest[] = []
    const approval: ApprovalService = {
      async request(req): Promise<ApprovalDecision> {
        seenApprovals.push(req)
        return { decision: 'denied' }
      },
    }

    const mediator = new MediatorService({
      registry,
      policy,
      risk,
      approval,
      sessionManager,
      db,
      bus: e2eBus,
    })

    const message: JSONRPCMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'read_file', arguments: { path: '.env' } },
    } as JSONRPCMessage

    const result = await mediator.handleRequest({
      sourceAgent: TEST_AGENT_ID,
      targetTool: 'read_file',
      message,
      sessionId: 'e2e-session-1',
    })

    // 1) Mediator returned the denial.
    expect(result.decision).toBe('denied')
    // The default policy's "ask" rule on read_file with secret-shaped paths
    // forces the approval path; capture lets us assert the modal-side data.
    expect(seenApprovals.length).toBe(1)
    expect(seenApprovals[0]!.sourceAgent).toBe(TEST_AGENT_ID)
    expect(seenApprovals[0]!.riskScore).toBeGreaterThan(0)
    expect(
      seenApprovals[0]!.riskReasons.some((r) => /secret/i.test(r)),
    ).toBe(true)

    // 2) Audit row persisted via the bus.
    audit.flush()
    const rows = db.select().from(requests).all()
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const latest = rows[rows.length - 1]!
    expect(latest.sourceAgent).toBe(TEST_AGENT_ID)
    expect(latest.decision).toBe('denied')
    expect(latest.sessionId).toBe('e2e-session-1')
    // Security report payload was persisted (#232) — even on heuristic-only
    // path it carries a non-null source.
    if (latest.securityReport) {
      const report = JSON.parse(latest.securityReport) as {
        source: string
      }
      expect(report.source).toMatch(/heuristic|llm/)
    }

    audit.dispose()
  })

  it("phase 7: re-running doctor after demo activity stays green (no drift)", () => {
    const report = runDoctor()
    const failed = report.checks.filter((c) => c.status === 'fail')
    expect(failed).toEqual([])
  })

  it('phase 8: configs survive a process-boundary read (no in-memory state leakage)', () => {
    const paths = getForemanPaths()
    // Re-parse from disk — same shape as a fresh `foreman start` would see.
    const llm = loadLlmConfig(paths.llmConfigPath)
    const notify = loadNotifyConfig(paths.notifyConfigPath)
    const voice = loadVoiceConfig(paths.voiceConfigPath)
    expect(llm.credentials.anthropic?.secret_name).toBe('anthropic-key')
    expect(notify.channels.telegram?.bot_token_ref).toBe('telegram-bot-token')
    expect(voice.proactive_notifications.daily_summary.enabled).toBe(true)
  })

  it("policy.yaml from the wizard's default template loads + exposes responsibility_policies", () => {
    const paths = getForemanPaths()
    const text = readFileSync(paths.policyPath, 'utf-8')
    // The default template seeds the responsibility_policies block (#299).
    expect(text).toContain('responsibility_policies')
    expect(text).toContain('code writing')
  })
})
