import { existsSync } from "node:fs";
import type { Interface as ReadlineInterface } from "node:readline";
import { Command } from "commander";
import { render, type Instance } from "ink";
import React from "react";
import {
  ApprovalBridge,
  BusApprovalService,
  DbApprovalService,
  ownApprovalTimeoutMs,
  ReadlineApprovalService,
  type ApprovalService,
} from "../core/approval.js";
import { AgentDaemonManager } from "../core/agent-daemon-manager.js";
import { AuditLogger } from "../core/audit.js";
import { bus, EventBus, type ForemanEventMap } from "../core/event-bus.js";
import {
  composeEscalationText,
  composeNudgeText,
  DelegationTracker,
} from "../core/delegation-tracker.js";
import { MediatorService } from "../core/mediator.js";
import { PolicyEngine } from "../core/policy-engine.js";
import { followPolicyFile, PolicyLoadError } from "../core/policy-load.js";
import { printPolicyLoadError } from "./policy-error.js";
import { buildAgentActivityDigest } from "../core/agent-activity-summary.js";
import { buildActivityPrompt } from "../core/agent-activity-prompt.js";
import { deliverWriteDirective } from "../core/agent-write.js";
import { executeWriteDirective } from "../core/agent-execute.js";
import { createHeuristicClassifier } from "../core/flow-classifier.js";
import { FlowManager } from "../core/flow-manager.js";
import { FlowRouter } from "../core/flow-router.js";
import { extractCwdFromTask } from "../core/extract-cwd-from-task.js";
import { ChatPrimaryService } from "../core/chat-primary.js";
import {
  ControlChannel,
  ControlDrainPoller,
  type ControlHandler,
} from "../core/control-channel.js";
import {
  acquireForemanPidfile,
  ForemanAlreadyRunningError,
  getForemanPidfilePath,
  otherForemanPid,
  PIDFILE_HEARTBEAT_MS,
  releaseForemanPidfile,
  touchForemanPidfile,
} from "../core/foreman-pidfile.js";
import { probeGateway, type GatewayProbe } from "../core/gateway.js";
import { defaultLlmConfig, saveLlmConfig } from "../core/llm/config.js";
import {
  ForemanCommandRouter,
  plainTextRefusal,
  registerBuiltinCommands,
} from "../core/foreman-command.js";
import {
  InboxRecorder,
  InboxService,
  oneLineSummary,
  recordDelegationOutcome,
  recordMissedApprovals,
} from "../core/inbox.js";
import { auditAgentTokens, describeTokenAudit } from "../core/agent-wiring.js";
import { responsibilityLookup } from "../core/mediator-stack.js";
import { OrchestratorChat } from "../core/orchestrator-chat.js";
import { RegistryService } from "../core/registry.js";
import { RiskScorer } from "../core/risk-scorer.js";
import { SessionManager } from "../core/session.js";
import { checkAgentUpdates } from "../core/agent-update-check.js";
import { loadActiveRegistry } from "../core/registry-catalog.js";
import { agentsSharingTelegram } from "../core/notification/telegram-listener.js";
import { checkForUpdate } from "../core/update-check.js";
import { closeDb, getDb, getSqlite, type ForemanDb } from "../db/client.js";
import { controlCommands } from "../db/schema.js";
import { loadOrCreateMasterKey } from "../identity/keypair.js";
import { App } from "../tui/app.js";
import type { BootInfo } from "../tui/boot-info.js";
import {
  freshState,
  hasUserOptedOut,
  loadSetupState,
  markSetupSkipped,
  saveSetupState,
} from "../tui/setup-state.js";
import { SetupWizard, type WizardOauthRunStep } from "../tui/setup-wizard.js";
import { runOauthFlows } from "./run-oauth-flow.js";
import { wizardIntegrations } from "./wizard-integrations.js";
import { runLoginWithSuspendedTui } from "../tui/run-login-in-tui.js";
import { SecretStore } from "../core/secret-store.js";
import type { IntegrationAuditSink } from "../core/integrations/service.js";
import { createIntegrationWiring, type IntegrationWiring } from "../core/integrations/wiring.js";
import { ConfirmationStore } from "../core/integrations/confirmations.js";
import { loadOrCreateSecretsMasterKey } from "../identity/master-key.js";
import {
  approvalButtonSigner,
  approvalSigner,
} from "../core/approval-token.js";
import { buildEnabledChannels } from "../core/notification/channel-factory.js";
import {
  RefusalAuditLimiter,
  type InteractionRefusalSink,
} from "../core/notification/interaction-refusals.js";
import { isHumanSource, orgBudgetBlock } from "../core/org/guard.js";
import {
  CommsMirrorWorker,
  mirrorsFromNotifyConfig,
} from "../core/org/comms-mirror.js";
import { OrgComms } from "../core/org/comms.js";
import { ApprovalReviews, ApprovalReviewWorker } from "../core/org/review.js";
import { BudgetWatcher } from "../core/usage/budget-watcher.js";
import { UsageLedger } from "../core/usage/ledger.js";
import { OtlpReceiver } from "../core/usage/otlp-receiver.js";
import { parseTaskUsage } from "../core/usage/task-usage.js";
import {
  loadOrCreateUsageKey,
  otlpPort,
  telemetryEnv,
} from "../core/usage/telemetry-env.js";
import {
  costBySession,
  recordUsageAndCheckBudget,
} from "../core/llm/budget.js";
import { isFeatureEnabled, loadLlmConfig } from "../core/llm/config.js";
import {
  buildLlmClient,
  LlmCredentialMissingError,
  LlmOAuthLoginRequiredError,
  LlmProviderUnavailableError,
} from "../core/llm/factory.js";
import { LlmVerifier } from "../core/llm/verifier.js";
import { BudgetAlertBridge } from "../core/llm/budget-alert-bridge.js";
import {
  NotificationBridge,
  type NotificationBridgeOptions,
} from "../core/notification/notification-bridge.js";
import { NotificationService } from "../core/notification/notification-service.js";
import { ForemanVoice } from "../core/notification/foreman-voice.js";
import {
  loadVoiceConfig,
  type VoiceConfig,
} from "../core/notification/voice-config.js";
import { PatternDetectionService } from "../core/pattern-detection-service.js";
import {
  channelConfig,
  loadNotifyConfig,
  routeFor,
} from "../core/notification/notify-config.js";
import { loadNotifyState } from "../core/notification/notify-state.js";
import {
  DailyScheduler,
  parseSchedule,
} from "../core/notification/scheduler.js";
import { generateSmartSummaryPayload } from "../core/notification/summary-generator.js";
import { launchEditor } from "../tui/launch-editor.js";
import { getForemanPaths } from "../utils/config.js";
import { runInit } from "./init.js";
import {
  DaemonAlreadyRunningError,
  DaemonUnavailableError,
  startHubDaemon,
  type HubDaemon,
} from "./hub-daemon.js";
import { daemonSupported } from "../core/daemon/protocol.js";
import { bold, dim, green, orange, red } from "./colors.js";
import { FOREMAN_VERSION } from "../version.js";

const APP_VERSION = FOREMAN_VERSION;

/** How often the headless gateway checks whether it can take the daemon
 *  socket over from a plain `foreman daemon`. */
const HUB_RETRY_MS = 3_000;

export class NotInitialisedError extends Error {
  constructor(public readonly rootPath: string) {
    super(
      `Foreman is not initialised at ${rootPath}. Run 'foreman init' first.`,
    );
    this.name = "NotInitialisedError";
  }
}

export interface StartedForeman {
  registry: RegistryService;
  audit: AuditLogger;
  approval: ApprovalService;
  policy: PolicyEngine;
  mediator: MediatorService;
  sessionManager: SessionManager;
  publicKey: Buffer;
  bootInfo: BootInfo;
  /** "tui": `foreman start` running the gateway itself; "headless": the
   *  background service's gateway; "attached": a TUI on top of a headless
   *  gateway that runs in another process. */
  mode: StartMode;
  /** Chat channels this process sends notifications to (empty when it
   *  runs none, e.g. attached). */
  channels: string[];
  waitForExit: () => Promise<void>;
  shutdown: () => Promise<void>;
}

export type StartMode = "tui" | "headless" | "attached";

export interface StartForemanOptions {
  /** Skip mounting the Ink TUI. Tests use this to avoid touching stdout. */
  withTui?: boolean;
  /**
   * Run as the headless gateway (`foreman daemon --service`): everything
   * `foreman start` runs except the TUI. Approvals of the tasks it runs
   * itself are DB-backed, so a TUI attached later shows them too. `log`
   * receives what a person should read (the service's log file).
   */
  headless?: { log: (message: string) => void };
  /**
   * Attach to the headless gateway with this pid, which owns the home:
   * run the TUI only. No second notification bridge, control drain,
   * scheduler, watcher, OTLP receiver, agent daemons or hub daemon; the
   * TUI works over the database (approvals, inbox, the control channel).
   */
  attach?: { pid: number };
}

export function startForeman(
  options: StartForemanOptions = {},
): StartedForeman {
  const paths = getForemanPaths();
  if (!existsSync(paths.root) || !existsSync(paths.identityPath)) {
    throw new NotInitialisedError(paths.root);
  }
  const attach = options.attach ?? null;
  const headless = options.headless ?? null;
  const mode: StartMode = attach ? "attached" : headless ? "headless" : "tui";
  // One gateway per home (#657): refuse before touching anything. An
  // attached TUI runs next to the gateway that holds the home.
  if (!attach) {
    const running = otherForemanPid(paths.configDir);
    if (running !== null) {
      throw new ForemanAlreadyRunningError(
        running,
        getForemanPidfilePath(paths.configDir),
      );
    }
  }
  const { publicKey } = loadOrCreateMasterKey();
  const db = getDb();
  const sqlite = getSqlite();
  const policy = new PolicyEngine(db, bus);
  // A broken policy.yaml stops here, before anything starts (#657): the
  // caller prints file, line and reason instead of a stack trace. From
  // then on the file is followed (#656): edits apply on the next call, and
  // a broken edit keeps the last good policy. Those errors wait for the
  // inbox, which is set up below.
  const earlyPolicyErrors: string[] = [];
  let reportPolicyError = (message: string): void => {
    earlyPolicyErrors.push(message);
  };
  followPolicyFile(policy, paths.policyPath, (message) =>
    reportPolicyError(message),
  );
  // #431 — Write the start.ts PID to a pidfile so `foreman mcp-stdio`
  // can signal us when a user types `/foreman stop` into an agent's
  // Telegram chat. Cleanup happens in shutdown(). Taking it is also the
  // single-instance lock (a start that raced the check above loses here).
  // It records which kind of gateway holds the home, and its mtime is a
  // heartbeat, so a `foreman start` can tell a live headless gateway (and
  // attach to it) from a stale file.
  let heartbeat: NodeJS.Timeout | null = null;
  if (!attach) {
    acquireForemanPidfile(paths.configDir, headless ? "headless" : "tui");
    heartbeat = setInterval(() => touchForemanPidfile(paths.configDir), PIDFILE_HEARTBEAT_MS);
    heartbeat.unref();
  }
  const registry = new RegistryService(db, bus);
  const audit = new AuditLogger(db, bus);
  const secretStore = new SecretStore(db, loadOrCreateSecretsMasterKey());
  const withTui = options.withTui ?? true;
  // The tasks the headless gateway runs itself (the control drain's ACP /
  // codex spawns) keep their approvals in the database, like an agent's
  // `foreman mcp-stdio` does, so the chat channels and a TUI attached later
  // both see them. The service's own bus is private: the mediator's
  // announcement on the shared bus is the one that counts (the bridge
  // adopts it, see adoptAnnounced below).
  const approval: ApprovalService = headless
    ? new DbApprovalService(db, {
        bus: new EventBus<ForemanEventMap>(),
        timeoutMs: ownApprovalTimeoutMs(),
      })
    : withTui
      ? new BusApprovalService({ bus })
      : new ReadlineApprovalService({ bus });
  const daemonManager = new AgentDaemonManager({
    paths,
    registry,
    onLifecycle: (event) => {
      const now = Date.now();
      switch (event.kind) {
        case "started":
          bus.emit("agent:daemon-started", {
            agentId: event.agentId,
            pid: event.pid,
            command: event.command,
            startedAt: now,
          });
          break;
        case "stopped":
          bus.emit("agent:daemon-stopped", {
            agentId: event.agentId,
            pid: event.pid,
            reason: event.reason,
            stoppedAt: now,
          });
          break;
        case "crashed":
          bus.emit("agent:daemon-crashed", {
            agentId: event.agentId,
            pid: event.pid,
            exitCode: event.exitCode,
            stderr: event.stderr,
            crashedAt: now,
          });
          break;
        case "skipped":
          bus.emit("agent:daemon-skipped", {
            agentId: event.agentId,
            reason: event.reason,
          });
          break;
      }
    },
  });
  // Agent daemons belong to the gateway; an attached TUI leaves them alone
  // (stopAll on its exit would SIGTERM the gateway's).
  if (!attach) daemonManager.startAll();
  const risk = new RiskScorer(db, undefined, {
    bucketOverrides: () => policy.getBucketOverrides(),
    // Wire the responsibility-violation rule (#300). Both lookups close
    // over `registry` + `policy` so a YAML reload or agent edit shows up
    // on the next request without rebuilding the scorer.
    getAgentResponsibility: responsibilityLookup(registry),
    responsibilityPolicies: () => policy.getResponsibilityPolicies(),
  });
  // QA-fix 2026-05-24 — wire the cost provider (#530 out-of-scope) so
  // session:completed events ship the real $X.XX instead of the
  // placeholder $0.00. costBySession does a sum query over
  // llm_usage.session_id — fast, no extra book-keeping.
  const sessionManager = new SessionManager(db, {
    bus,
    costProvider: (sid) => costBySession(db, sid).totalUsd,
  });
  // Responsibility-based auto-routing (docs/auto-routing-design.md).
  // FlowManager is the DB-backed lifecycle store; FlowRouter consumes
  // it + the classifier + the registry to decide each post-spawn
  // handoff. Both are process-scoped and cheap to instantiate.
  const flowManager = new FlowManager(db);
  const flowRouter = new FlowRouter(
    flowManager,
    registry,
    createHeuristicClassifier(),
  );
  // Optional LLM verifier (#231 / C8) — only built when llm.yaml has the
  // verification feature on AND credentials resolve. Failures are silent so
  // the heuristic-only flow stays unaffected.
  const verifier = setupLlmVerifier({
    db,
    secretStore,
    llmConfigPath: paths.llmConfigPath,
  });
  const mediator = new MediatorService({
    registry,
    policy,
    risk,
    approval,
    sessionManager,
    db,
    bus,
    verifier: verifier ?? undefined,
  });

  // Surface pending approvals from spawned `foreman mcp-stdio` / `foreman
  // wrap` processes into this process's bus, so the TUI's approval modal
  // fires for cross-process requests too (#117).
  // Started below, once the inbox and notification listeners are attached,
  // so approvals already pending at launch reach them too.
  // Both a gateway and an attached TUI run one: a decision is written to
  // the row only while it is still pending, so exactly one counts, and
  // each process learns the outcome from the database.
  const approvalBridge = new ApprovalBridge(db, { bus, adoptAnnounced: headless !== null });

  // In-app inbox (#613): every approval, block, crash and update, kept
  // with read state so the TUI shows what happened while you were away —
  // with or without external channels configured. The gateway records it;
  // an attached TUI reads it (it refreshes from the database).
  const inbox = new InboxService(db, bus);
  // Approvals that timed out while Foreman wasn't running (#657).
  if (!attach) {
    try {
      recordMissedApprovals(db, inbox);
    } catch {
      /* best-effort, like the rest of the inbox */
    }
  }
  const inboxRecorder = new InboxRecorder(db, inbox, { bus });
  reportPolicyError = (message) => {
    inbox.add({
      level: "warning",
      kind: "system",
      title: "policy.yaml has an error: the last good policy stays in force",
      body: message,
      dedupeKey: `policy-error:${message}`,
    });
  };
  for (const message of earlyPolicyErrors.splice(0)) reportPolicyError(message);
  if (!attach) {
    inboxRecorder.start();
    warnAboutAgentTokens(registry, secretStore, inbox, withTui);
  }

  // The daemon (#616): agents' `foreman mcp-stdio` and the PreToolUse hook
  // connect to it instead of each booting the mediation stack (and every
  // MCP hub server) themselves. They fall back to doing that when it isn't
  // there, with the same decisions.
  //
  // An attached TUI never hosts it: the gateway it attached to does.
  let hubDaemon: HubDaemon | null = null;
  let hubDaemonStopping = false;
  // Wakes the headless gateway's wait for the socket on shutdown.
  let wakeHubRetry: (() => void) | null = null;
  const hubLog = (message: string): void => {
    headless?.log(message);
    inbox.add({
      level: "warning",
      kind: "system",
      title: "Foreman daemon",
      body: message,
      dedupeKey: `daemon:${message}`,
    });
  };
  const startHub = async (): Promise<void> => {
    for (let waiting = false; ; ) {
      try {
        const daemon = await startHubDaemon({ paths, log: hubLog });
        if (hubDaemonStopping) {
          await daemon.close();
          return;
        }
        hubDaemon = daemon;
        headless?.log(`listening on ${daemon.socketPath}`);
        return;
      } catch (err) {
        // The headless gateway takes the socket over from a plain
        // `foreman daemon` once that one stops, as the 2.2.0 service did;
        // `foreman start` leaves agents on it (below).
        if (!headless || !(err instanceof DaemonAlreadyRunningError) || hubDaemonStopping) throw err;
        if (!waiting) headless.log(`${err.message}; waiting to take over when it stops`);
        waiting = true;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, HUB_RETRY_MS);
          wakeHubRetry = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wakeHubRetry = null;
        if (hubDaemonStopping) return;
      }
    }
  };
  const hubDaemonReady: Promise<void> = daemonSupported() && !attach
    ? startHub()
        .catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          headless?.log(`agents run without the daemon: ${reason}`);
          if (err instanceof DaemonAlreadyRunningError) {
            // The background service (`foreman service`) or a `foreman
            // daemon` got there first: agents use it. Its approvals are
            // DB-backed, so they still reach this TUI (ApprovalBridge).
            inbox.add({
              level: "info",
              kind: "system",
              title: "Agents use the Foreman daemon that is already running",
              body:
                `${reason} (the background service, or a \`foreman daemon\`). Agents and the hook keep using it; ` +
                "their approvals still appear here. `foreman service status` shows the service.",
              dedupeKey: "daemon-already-running",
            });
            return;
          }
          inbox.add({
            level: err instanceof DaemonUnavailableError ? "info" : "warning",
            kind: "system",
            title: "Agents run without the Foreman daemon",
            body:
              `${reason}. Each agent's foreman mcp-stdio and every hook call start Foreman on their own: ` +
              "the same decisions, only slower, and each agent runs its own copy of the MCP hub servers.",
            dedupeKey: `daemon-unavailable:${reason}`,
          });
        })
    : Promise.resolve();

  // Spend ledger (#629): agents report their token usage over
  // OpenTelemetry to a receiver on 127.0.0.1; spawned tasks get the
  // exporter settings automatically (see telemetry-env.ts).
  const usageLedger = new UsageLedger(db, {
    orgConfigPath: paths.orgConfigPath,
  });
  const usageKey = loadOrCreateUsageKey(paths.root);
  // Budgets are checked as soon as usage arrives (the watcher is created
  // below, once the notification channels exist).
  let onUsageRecorded: () => void = () => {};
  const otlp = new OtlpReceiver({
    ledger: usageLedger,
    key: usageKey,
    port: otlpPort(),
    onRecorded: () => onUsageRecorded(),
  });
  let otlpBoundPort: number | null = null;
  // The gateway's receiver takes the port; an attached TUI has none.
  if (!attach) otlp
    .start()
    .then((port) => {
      otlpBoundPort = port;
    })
    .catch(() => {
      headless?.log(`agent spend tracking is off: port ${otlpPort()} is in use`);
      inbox.add({
        level: "warning",
        kind: "system",
        title: `Agent spend tracking is off: port ${otlpPort()} is in use`,
        body: "Set FOREMAN_OTLP_PORT to a free port and restart foreman start.",
        dedupeKey: `otlp-port:${otlpPort()}`,
      });
    });

  // Chat verbs for the TUI command bar (#612) — the same router the
  // Telegram / MCP path uses. Created up front so the TUI gets it.
  const controlChannel = new ControlChannel(db, bus);
  const commandRouter = new ForemanCommandRouter();
  registerBuiltinCommands(commandRouter);
  let orchestratorChat: OrchestratorChat | null = null;
  try {
    orchestratorChat = new OrchestratorChat({
      db,
      config: existsSync(paths.llmConfigPath)
        ? loadLlmConfig(paths.llmConfigPath)
        : defaultLlmConfig(),
      secretStore,
      registry,
      bus,
    });
  } catch {
    orchestratorChat = null;
  }

  // Autonomous loop tracker — records every `foreman write` delegation
  // and lets the watchdog nudge initiators that go idle after the peer
  // finishes. See `src/core/delegation-tracker.ts` for the lifecycle.
  // Watchdog timer is set up below the drain loop wiring.
  const delegationTracker = new DelegationTracker({ db });

  // OOB notification bridge (#235 / C11a-2). Best-effort: any failure here
  // (notify.yaml malformed, secret missing, etc.) is logged but does NOT
  // block start — the TUI modal still works on its own.
  // Shared by the TUI console and by `/foreman` in Slack / Discord.
  // Integrations for the TUI page and `/integration …` from chat; changes
  // made from chat land in the inbox too.
  const integrationWiring = integrationsForTui(secretStore, audit).integrations;
  const integrationConfirmations = new ConfirmationStore();
  const commandContext = {
    db,
    registry,
    llmConfigPath: paths.llmConfigPath,
    configDir: paths.configDir,
    controlChannel,
    ownerStore: secretStore,
    secretStore,
    ...(orchestratorChat ? { orchestratorChat } : {}),
    ...(integrationWiring
      ? {
          integrations: {
            service: integrationWiring.service,
            confirmations: integrationConfirmations,
            notice: (title: string) =>
              inbox.add({ level: "info", kind: "system", title, dedupeKey: `integration:${Date.now()}:${title}` }),
          },
        }
      : {}),
  };
  // `/foreman …` typed in Slack or Discord. The channel already checked the
  // sender against its allowed_user_ids over a connection only Foreman
  // holds, so it runs as the owner, like the TUI. Audited either way.
  const runChatCommand = async (
    channel: "slack" | "discord" | "telegram",
    text: string,
    userId: string,
    opts: { plain?: boolean } = {},
  ): Promise<string> => {
    // `/integrations` and `/integration …` are verbs of their own; a
    // Telegram `@bot` suffix never reaches here (the channel strips it).
    const [verb = "help", ...args] = text
      .trim()
      .replace(/^\/?foreman\b\s*/i, "")
      .replace(/^\//, "")
      .split(/\s+/)
      .filter(Boolean);
    const sourceUser = `${channel}:${userId}`;
    const refusal = opts.plain ? plainTextRefusal(commandRouter, registry, verb, args) : null;
    if (refusal !== null) {
      audit.logEvent("foreman:command", {
        command: verb,
        args,
        sourceAgent: channel,
        sourceUser,
        ok: false,
        errorCode: "PLAIN_TEXT_CHANGE",
      });
      return refusal;
    }
    const result = await commandRouter.dispatch(verb, args, {
      ...commandContext,
      sourceAgent: channel,
      sourceUser,
      trustedOwner: true,
      integrationOwner: isIntegrationOwner(paths.notifyConfigPath, channel, userId),
    });
    audit.logEvent("foreman:command", {
      command: verb,
      args,
      sourceAgent: channel,
      sourceUser,
      ok: result.ok,
      errorCode: result.errorCode ?? null,
    });
    return result.text;
  };

  // Slack / Discord taps and commands from people who are not allowed:
  // audited, at most once per user per minute (interaction-refusals.ts).
  const refusals = new RefusalAuditLimiter(
    (event) => audit.logEvent("notify:interaction-refused", event),
    { isKnownCommand: (verb) => commandRouter.has(verb) },
  );
  // One notification bridge per home: the gateway's. Telegram allows one
  // getUpdates poller per bot, and Slack / Discord must not get every
  // approval twice, so an attached TUI runs none.
  const notificationSetup = attach ? null : setupNotificationBridge({
    db,
    secretStore,
    telegramSharedWith: telegramSharedWith(registry),
    onChatCommand: runChatCommand,
    onChannelDecision: (info) =>
      audit.logEvent("approval:channel-decision", info),
    onInteractionRefused: (refusal) => {
      refusals.record(refusal);
    },
    notifyConfigPath: paths.notifyConfigPath,
    notifyStatePath: paths.notifyStatePath,
    llmConfigPath: paths.llmConfigPath,
    // Channel trouble (e.g. someone else polling the approval bot) lands
    // in the inbox, once per distinct message.
    onChannelWarning: (message) => {
      headless?.log(message);
      inbox.add({
        level: "warning",
        kind: "system",
        title: message,
        dedupeKey: `channel:${message}`,
      });
    },
  });
  const notificationBridge = notificationSetup?.bridge ?? null;
  const dailyScheduler = notificationSetup?.scheduler ?? null;

  // Approval escalation along reporting lines (#623): low- and medium-risk
  // approvals also go to the requester's manager agent, whose
  // recommendation is shown next to the approval. Advice only.
  const approvalReviews = new ApprovalReviews(
    db,
    new OrgComms(db, { orgConfigPath: paths.orgConfigPath, bus }),
    {
      registry,
    },
  );
  const reviewWorker = new ApprovalReviewWorker(approvalReviews, {
    bus,
    inbox,
  });
  // The gateway asks the managers; an attached TUI only reads their advice.
  if (!attach) reviewWorker.start();
  approvalBridge.start();

  // Department channels (#630): mirror what agents say to each other to
  // the Slack / Discord channels org.yaml maps, with the bot tokens from
  // notify.yaml. Agents never hold those tokens.
  const commsMirror = new CommsMirrorWorker(db, {
    orgConfigPath: paths.orgConfigPath,
    mirrors: mirrorsFromNotifyConfig(
      chatBotTokens(paths.notifyConfigPath, secretStore),
    ),
    inbox,
  });
  if (!attach) commsMirror.start();

  // Department budgets from org.yaml (#629): inbox + alert channels.
  const budgetWatcher = new BudgetWatcher(db, {
    orgConfigPath: paths.orgConfigPath,
    inbox,
    ...(notificationSetup
      ? {
          notify: (title: string, body: string) => {
            void notificationSetup.service
              .send("budget_alert", {
                level: "budget_alert",
                requestId: null,
                title,
                body,
                actions: [],
                agentBlocking: false,
              })
              .catch(() => undefined);
          },
        }
      : {}),
  });
  if (!attach) budgetWatcher.start();
  onUsageRecorded = () => budgetWatcher.checkSoon();

  // #303 / #304 / #305 — ForemanVoice + pattern detection. Only started
  // when notify is configured (no proactive messages to send otherwise).
  // voice.yaml seeds quiet-hours + per-type throttle when present; absent
  // file = built-in defaults.
  let voice: ForemanVoice | null = null;
  let patternDetector: PatternDetectionService | null = null;
  if (notificationSetup) {
    let voiceConfig: VoiceConfig;
    try {
      voiceConfig = loadVoiceConfig(paths.voiceConfigPath);
    } catch {
      // Parse error — fall back to defaults so a malformed voice.yaml
      // doesn't block start. Doctor surfaces the parse failure separately.
      voiceConfig = loadVoiceConfig("/dev/null/nonexistent");
    }
    voice = new ForemanVoice({
      service: notificationSetup.service,
      bus,
      quietHours: voiceConfig.quiet_hours,
      throttleMs: {
        pattern_detection:
          voiceConfig.proactive_notifications.pattern_detection
            .cooldown_minutes * 60_000,
      },
    });
    voice.start();
    if (voiceConfig.proactive_notifications.pattern_detection.enabled) {
      patternDetector = new PatternDetectionService({
        db,
        voice,
        thresholds: {
          repeatedDenialMin:
            voiceConfig.proactive_notifications.pattern_detection
              .min_pattern_frequency,
          repeatedAllowMin: 5,
          burstMin: 10,
          burstWindowMs: 60_000,
          repeatedWindowMs: 60 * 60 * 1000,
          offResponsibilityMin:
            voiceConfig.proactive_notifications.pattern_detection
              .min_pattern_frequency,
        },
      });
      patternDetector.start();
    }
  }

  // #435 — Activity summary daily trigger. Off-by-default — fires only
  // when notify.yaml configures `routing.activity_summary` with at
  // least one channel + a parseable `daily HH:MM` schedule AND
  // `features.orchestrator_chat` is enabled in llm.yaml. Reuses
  // ForemanVoice.sendProactive for the actual delivery so quiet-hours
  // + throttle policies apply.
  let activitySummaryScheduler: DailyScheduler | null = null;
  if (notificationSetup && voice) {
    activitySummaryScheduler = setupActivitySummaryScheduler({
      db,
      registry,
      secretStore,
      llmConfigPath: paths.llmConfigPath,
      notifyConfigPath: paths.notifyConfigPath,
      voice,
    });
  }

  const bootInfo: BootInfo = {
    publicKey,
    policyRules: policy.list().length,
    dbPath: paths.dbPath,
    gateway: { stdio: true },
    version: APP_VERSION,
  };

  let instance: Instance | null = null;
  let exitResolve: (() => void) | null = null;
  let keepAlive: NodeJS.Timeout | null = null;
  // Assigned once the delegation watchdog starts (below); cleared on
  // shutdown so it can't tick against a closed database.
  let watchdogTimer: NodeJS.Timeout | null = null;

  void checkForUpdate(APP_VERSION).then((result) => {
    if (result && result.hasUpdate) {
      bus.emit("update:available", {
        current: result.current,
        latest: result.latest,
        source: result.source,
      });
    }
  });

  void (async (): Promise<void> => {
    try {
      const { doc } = loadActiveRegistry();
      const statuses = await checkAgentUpdates(registry.list(), doc);
      const updates = statuses
        .filter((s) => s.hasUpdate && s.current && s.latest)
        .map((s) => ({
          id: s.agentId,
          displayName: s.displayName,
          current: s.current as string,
          latest: s.latest as string,
        }));
      if (updates.length > 0) {
        bus.emit("agent-update:available", { updates });
      }
      const warnings = statuses
        .filter((s) => s.isOvershoot && s.current)
        .map((s) => ({
          id: s.agentId,
          displayName: s.displayName,
          installed: s.current as string,
          supportedRange: s.supportedRange,
        }));
      if (warnings.length > 0) {
        bus.emit("agent-update:overshoot", { warnings });
      }
    } catch {
      /* never surface boot-time check errors */
    }
  })();

  if (withTui) {
    // #tui-login — Suspend the live Ink frame while an interactive auth CLI
    // takes over the terminal, then restore. The closure reads `instance`
    // lazily (it's assigned on the next line) so the runner always sees the
    // mounted render handle.
    const runInteractiveLogin = (
      steps: WizardOauthRunStep[],
    ): ReturnType<typeof runOauthFlows> =>
      runLoginWithSuspendedTui(steps, instance);
    instance = render(
      React.createElement(App, {
        bootInfo,
        services: {
          db,
          sqlite,
          bus,
          registry,
          mediator,
          policy,
          policyPath: paths.policyPath,
          soulPath: paths.soulPath,
          sessionManager,
          secretStore,
          runInteractiveLogin,
          inbox,
          pendingApprovals: () => approvalBridge.pending(),
          approvalRecommendations: (approvalId: string) =>
            approvalReviews.recommendationsFor(approvalId),
          commandRouter,
          commandContext,
          audit,
          orgConfigPath: paths.orgConfigPath,
          ...(integrationWiring ? { integrations: integrationWiring } : {}),
          ...(attach ? { attachedGateway: () => attachedGatewayState(paths.configDir) } : {}),
        },
      }),
      { exitOnCtrlC: false },
    );
  } else {
    keepAlive = setInterval(() => {}, 1 << 30);
  }

  const waitForExit = (): Promise<void> => {
    if (instance) return instance.waitUntilExit().then(() => undefined);
    return new Promise<void>((resolve) => {
      exitResolve = resolve;
    });
  };

  const shutdown = async (): Promise<void> => {
    if (instance) {
      instance.unmount();
      instance = null;
    }
    if (keepAlive) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (exitResolve) {
      const r = exitResolve;
      exitResolve = null;
      r();
    }
    // First, so new hook calls and agent sessions fall back to their own
    // process while the rest shuts down; calls still waiting on the daemon
    // are refused (fail closed), never left to be allowed later.
    hubDaemonStopping = true;
    wakeHubRetry?.();
    await hubDaemonReady;
    const daemon = hubDaemon as HubDaemon | null;
    hubDaemon = null;
    if (daemon) await daemon.close().catch(() => undefined);
    // The headless gateway's own tasks: an approval still open is
    // cancelled (denied) now, never left for a decision nobody relays.
    if (approval instanceof DbApprovalService) approval.close();
    approvalBridge.stop();
    reviewWorker.stop();
    inboxRecorder.stop();
    budgetWatcher.stop();
    commsMirror.stop();
    void otlp.stop();
    // Waits for a command already running (#633 QA: quitting the demo
    // mid-command closed the database underneath it, exit 7).
    await controlPoller.stop();
    if (dailyScheduler) dailyScheduler.stop();
    if (activitySummaryScheduler) activitySummaryScheduler.stop();
    if (patternDetector) patternDetector.stop();
    if (voice) voice.dispose();
    if (notificationBridge) {
      // Bounded: a chat connection that won't close must not keep agent
      // daemons running and the pidfile behind.
      await Promise.race([
        notificationBridge.stop().catch(() => {
          /* best-effort cleanup */
        }),
        new Promise((resolve) => setTimeout(resolve, 5_000).unref()),
      ]);
    }
    // SIGTERM every tracked agent daemon, wait up to 5s, then SIGKILL.
    // Awaited so foreman doesn't exit with stranded children. An attached
    // TUI leaves them to the gateway.
    if (!attach) {
      await daemonManager.stopAll().catch(() => {
        /* best-effort cleanup */
      });
    }
    try {
      // May throw if another process holds the database past its busy
      // timeout (#594); the pidfile and the handle still go.
      audit.dispose();
    } finally {
      // Only our own: an attached TUI must not remove the gateway's, and a
      // gateway that took over meanwhile keeps its own.
      releaseForemanPidfile(paths.configDir);
      closeDb();
    }
  };

  // SIGINT (Ctrl-C in TUI) AND SIGTERM (delivered by `/foreman stop`
  // via the mcp-stdio command router) both unblock the exit promise
  // and let the shutdown path run.
  const onSignal = (): void => {
    if (instance) instance.unmount();
    if (exitResolve) {
      const r = exitResolve;
      exitResolve = null;
      r();
    }
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  // #440 — Cross-process control channel. mcp-stdio enqueues
  // mutating commands; this drain loop dispatches them inside the
  // `foreman start` process where the daemon manager + LlmConfig live.
  // #498 — Bus injection so drain outcomes surface as control:applied /
  // control:failed events; the TUI Activity feed subscribes for live
  // status transitions.
  const controlHandlers = new Map<string, ControlHandler>([
    [
      "stop",
      async () => {
        // Schedule shutdown after the row is marked applied so the
        // channel write commits before we exit.
        setTimeout(() => {
          onSignal();
        }, 50);
        return { status: "applied" };
      },
    ],
    [
      "llm-switch",
      async (row) => {
        try {
          const [provider, model] = JSON.parse(row.args) as string[];
          if (!provider || !model) {
            return {
              status: "rejected",
              error: "llm-switch requires provider + model args",
            };
          }
          const current = existsSync(paths.llmConfigPath)
            ? loadLlmConfig(paths.llmConfigPath)
            : ({} as ReturnType<typeof loadLlmConfig>);
          const next = {
            ...current,
            enabled: true,
            provider: provider as typeof current.provider,
            model,
          };
          saveLlmConfig(paths.llmConfigPath, next);
          return { status: "applied" };
        } catch (err) {
          return {
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    ],
    [
      "llm-budget",
      async (row) => {
        try {
          const [usdStr] = JSON.parse(row.args) as string[];
          const usd = Number.parseFloat(usdStr ?? "");
          if (!Number.isFinite(usd) || usd <= 0) {
            return {
              status: "rejected",
              error: "llm-budget requires a positive USD amount",
            };
          }
          const current = loadLlmConfig(paths.llmConfigPath);
          const next = {
            ...current,
            budget: { ...current.budget, monthly_cap_usd: usd },
          };
          saveLlmConfig(paths.llmConfigPath, next);
          return { status: "applied" };
        } catch (err) {
          return {
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    ],
    [
      "agent-model",
      async (row) => {
        // #502 — `/foreman model <agent-id> <model>` writes
        // `agents.model_version`. Empty string ("") clears the
        // override → future spawns use the agent's own config default.
        try {
          const [agentId, model] = JSON.parse(row.args) as string[];
          if (!agentId) {
            return {
              status: "rejected",
              error: "agent-model requires [agentId, model] args",
            };
          }
          if (!registry.get(agentId)) {
            return {
              status: "rejected",
              error: `unknown agent "${agentId}"`,
            };
          }
          const normalized = (model ?? "").trim();
          registry.setModelVersion(
            agentId,
            normalized.length > 0 ? normalized : null,
          );
          return { status: "applied" };
        } catch (err) {
          return {
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    ],
    [
      "write",
      async (row) => {
        // #433 — `/foreman write <agent> <message>`. Delivery is
        // hybrid: always a visible Telegram post (so the human sees
        // it + can manually forward), plus an optional inbound_dir
        // file when the agent declares one. The user-side reply
        // ("Directive queued for openclaw") already went out via
        // mcp-stdio; this loop just executes the side-effects.
        try {
          // Args format: classic `[agentId, message]`, or flow-aware
          // `[agentId, message, flowId, stepId]`. The 4-element variant
          // signals that this directive is a step inside an active flow
          // and the executor should hand it the router so the post-spawn
          // hook can classify + chain.
          const parsed = JSON.parse(row.args) as string[];
          const [agentId, message, flowId, stepId] = parsed;
          if (!agentId || !message) {
            return {
              status: "rejected",
              error: "write requires [agentId, message] args",
            };
          }
          if (!registry.get(agentId)) {
            return {
              status: "rejected",
              error: `unknown agent "${agentId}"`,
            };
          }
          const registryDoc = loadActiveRegistry();
          const entry = registryDoc.doc.agents.find((a) => a.id === agentId);
          const inboundDir = entry?.inbound_dir;
          const telegramBotToken = secretStore.exists("telegram-bot-token")
            ? secretStore.get("telegram-bot-token")
            : undefined;
          const telegramChatId = secretStore.exists("telegram-chat-id")
            ? secretStore.get("telegram-chat-id")
            : undefined;
          // PR D — when the target agent declares task_command_template
          // we ACTUALLY spawn the agent here (via PR C's engine) and
          // post the captured output back via Telegram. The directive's
          // initial "queued" ack already went out via mcp-stdio's tool
          // response; this is the follow-up post with the result.
          // Agents without the template fall back to the v0.1 queue+
          // relay path (Telegram visible post + inbound_dir file).
          //
          // #445 / #552 (post-launch fix) — ACP agents (Hermes/OpenClaw/
          // ZeroClaw) declare `approval_adapter='acp-stdio-v1'` +
          // `acp_command` instead of `task_command_template`. Without
          // this extension they were silently falling through to the
          // legacy hybrid path, breaking the integration shipped in
          // #568. The `executeWriteDirective` ACP branch handles the
          // actual spawn via runAcpMediatedTask; we just need the
          // dispatch gate to include them.
          const isAcpAgent =
            entry?.approval_adapter === "acp-stdio-v1" &&
            entry.acp_command !== undefined;
          if (entry?.task_command_template || isAcpAgent) {
            // Pick up the per-agent model override stored in `agents.
            // model_version` so the spawn engine can append the
            // registry's `task_model_flag` argv pair (e.g. `--model
            // claude-sonnet-4-6`). NULL = use the agent's own default.
            // #517 Faz 3 wiring — read the operator-set trust flag so
            // `foreman agent trust <id>` actually flips the spawn into
            // `--full-auto` / `--dangerously-skip-permissions` mode.
            // Without this forward, the DB flag was a silent no-op + a
            // trusted codex still ran in `sandbox: read-only` (#544 finish).
            const registryRow = registry.get(agentId);
            // QA-fix 2026-05-24 — extract a workdir hint from the task
            // text so codex's sandbox roots include the project the
            // user actually mentioned. Without this, codex landed in
            // Foreman's own cwd and refused to write outside it.
            const derivedCwd = extractCwdFromTask(message);
            // QA-fix 2026-05-24 (Wiring 4) — heartbeat the agent so its
            // status flips from "never seen" to a real timestamp.
            // Best-effort; ignore if the row was racey-removed.
            try {
              registry.heartbeat(agentId);
            } catch {
              /* ignore — agent might have been removed mid-drain */
            }
            // Responsibility-based auto-routing — when args carry
            // flowId + stepId, wire the executor with a FlowRouter +
            // an enqueueFollowUp callback. The callback inserts the
            // next step's directive into control_commands so the next
            // drain iteration spawns it (no recursive call from inside
            // the drain handler).
            const flowContext =
              flowId && stepId
                ? {
                    flowId,
                    stepId,
                    flowManager,
                    router: flowRouter,
                    enqueueFollowUp: async (next: {
                      targetAgent: string;
                      prompt: string;
                      flowId: string;
                      stepId: string;
                    }): Promise<number | null> => {
                      const inserted = db
                        .insert(controlCommands)
                        .values({
                          command: "write",
                          args: JSON.stringify([
                            next.targetAgent,
                            next.prompt,
                            next.flowId,
                            next.stepId,
                          ]),
                          sourceAgent: "foreman:flow-router",
                          sourceUser: row.sourceUser ?? null,
                          status: "pending",
                          createdAt: Date.now(),
                        })
                        .returning({ id: controlCommands.id })
                        .get();
                      return inserted?.id ?? null;
                    },
                  }
                : undefined;
            // Department budgets, enforced here too: whichever path queued
            // it (chat, CLI, flow routing), an agent can't hand work into
            // a department that has spent its budget.
            if (!isHumanSource(row.sourceAgent ?? "cli")) {
              const overBudget = orgBudgetBlock(
                db,
                paths.orgConfigPath,
                agentId,
              );
              if (overBudget)
                return {
                  status: "failed",
                  error: `paused by budget: ${overBudget}`,
                };
            }
            // Mark the step running before the spawn so `foreman flow
            // show` reflects in-progress state in real time.
            if (flowId && stepId) {
              try {
                flowManager.markStepRunning(stepId, row.id);
              } catch {
                /* ignore — step might have been racey-removed */
              }
            }
            // Autonomous loop tracker — when an LLM agent (Hermes,
            // OpenClaw, …) issues a new `foreman write`, that's our
            // heuristic for "they're acting on whatever peer output
            // they last received." Close their open awaiting/nudged
            // delegations before recording the new one. Skip for
            // `sourceAgent === 'cli'` (terminal user; no chat to
            // nudge).
            const initiator = row.sourceAgent ?? "cli";
            if (!isHumanSource(initiator)) {
              try {
                delegationTracker.closeOpenInitiatorRows(initiator);
              } catch (err) {
                process.stderr.write(
                  `foreman: tracker.closeOpenInitiatorRows failed: ${
                    err instanceof Error ? err.message : String(err)
                  }\n`,
                );
              }
            }
            const taskUsageKey = otlpBoundPort
              ? otlp.issueTaskKey(agentId, String(row.id))
              : null;
            const exec = await executeWriteDirective(
              {
                agentId,
                message,
                sourceUser: row.sourceUser ?? undefined,
                entry,
                modelVersion: registryRow?.modelVersion ?? null,
                taskSkipPermissions: registryRow?.taskSkipPermissions === true,
                ...(derivedCwd ? { cwd: derivedCwd } : {}),
                // Report the task's token usage to the spend ledger, with
                // a key that can only book usage to this agent and task.
                ...(otlpBoundPort && taskUsageKey
                  ? {
                      extraEnv: telemetryEnv({
                        port: otlpBoundPort,
                        key: taskUsageKey,
                        agentId,
                        taskRef: String(row.id),
                      }),
                    }
                  : {}),
                // QA-fix 2026-05-24 (Wiring 4) — hand the session
                // manager to the executor so it opens/closes a session
                // around the spawn. Lights up #523 lifecycle pushes,
                // #530 cost rollup, and the TUI Sessions panel.
                sessionManager,
                ...(flowContext ? { flowContext } : {}),
              },
              {
                telegramBotToken,
                telegramChatId,
                // #445 / #552 — Required by the ACP path so every
                // approval the agent emits during the prompt routes
                // through Foreman's risk + approval pipeline. The
                // codex / task_command_template path ignores this
                // option — only the ACP branch reads it.
                mediator,
                // Autonomous loop tracker — executor records the
                // delegation lifecycle for the watchdog below.
                tracker: delegationTracker,
                initiatorAgent: initiator,
                controlCommandId: row.id,
              },
            );
            // #498 — Always audit the spawn outcome. control_commands.error
            // only stores a one-liner (e.g. "agent exited 1"); the real
            // stderr/stdout was previously lost. Persist the full capture
            // so users (and future us) can debug "why did claude --print
            // fail" without instrumenting per-bug. Truncate to keep audit
            // rows from ballooning under chatty agents.
            audit.logEvent("control_write_outcome", {
              id: row.id,
              agentId,
              // task_command_template for codex/claude-code; for ACP
              // agents we record the acp_command argv so the audit
              // row still tells the operator what got spawned.
              command:
                entry.task_command_template ??
                (entry.acp_command
                  ? `${entry.acp_command.command} ${(entry.acp_command.args ?? []).join(" ")}`.trim()
                  : null),
              spawnKind: exec.spawn.kind,
              exitCode:
                exec.spawn.kind === "ok" || exec.spawn.kind === "failed"
                  ? exec.spawn.exitCode
                  : null,
              durationMs:
                "durationMs" in exec.spawn ? exec.spawn.durationMs : null,
              timeoutMs:
                exec.spawn.kind === "timeout" ? exec.spawn.timeoutMs : null,
              stdoutLen: "stdout" in exec.spawn ? exec.spawn.stdout.length : 0,
              stderrLen: "stderr" in exec.spawn ? exec.spawn.stderr.length : 0,
              stdoutTail:
                "stdout" in exec.spawn ? exec.spawn.stdout.slice(-2000) : null,
              stderrTail:
                "stderr" in exec.spawn ? exec.spawn.stderr.slice(-2000) : null,
              spawnError:
                exec.spawn.kind === "spawn-error" ? exec.spawn.error : null,
              unsupportedReason:
                exec.spawn.kind === "unsupported" ? exec.spawn.reason : null,
              outputRelay: exec.outputRelay,
            });
            if (taskUsageKey) otlp.revokeTaskKey(taskUsageKey);
            // Usage the agent printed (Codex `tokens used`, Claude JSON
            // results); telemetry for the same task takes precedence.
            if ("stdout" in exec.spawn) {
              const printed = parseTaskUsage(
                exec.spawn.stdout,
                exec.spawn.stderr,
              );
              if (printed) {
                try {
                  usageLedger.record({
                    agentId,
                    source: "task-output",
                    ...printed,
                    // The agent's configured model prices a bare token count.
                    model: printed.model ?? registryRow?.modelVersion ?? null,
                    taskRef: String(row.id),
                  });
                  onUsageRecorded();
                } catch {
                  /* reporting only */
                }
              }
            }
            // The TUI promised "output will arrive in your inbox".
            recordDelegationOutcome(inbox, {
              controlId: row.id,
              agentId,
              task: message,
              spawn: exec.spawn,
            });
            if (exec.spawn.kind === "ok") {
              return { status: "applied" };
            }
            // Failed / timeout / spawn-error still mark the row as
            // failed for audit traceability — the output relay already
            // delivered the error explanation to the user's chat.
            return {
              status: "failed",
              error:
                exec.spawn.kind === "failed"
                  ? `agent exited ${exec.spawn.exitCode}`
                  : exec.spawn.kind === "timeout"
                    ? `agent timed out after ${exec.spawn.timeoutMs}ms`
                    : exec.spawn.kind === "spawn-error"
                      ? `spawn error: ${exec.spawn.error}`
                      : `unsupported: ${exec.spawn.reason}`,
            };
          }
          const outcome = await deliverWriteDirective(
            {
              agentId,
              message,
              sourceUser: row.sourceUser ?? undefined,
              inboundDir,
            },
            { telegramBotToken, telegramChatId },
          );
          if (outcome.status === "failed") {
            return { status: "failed", error: outcome.error };
          }
          inbox.add({
            level: "info",
            kind: "delegation",
            title: `Task handed to ${agentId}: ${oneLineSummary(message, 60)}`,
            body: `${agentId} has no non-interactive command, so the task was posted for it to pick up.`,
            agentId,
            dedupeKey: `control:${row.id}:outcome`,
          });
          return { status: "applied" };
        } catch (err) {
          return {
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    ],
  ]);
  const controlPoller = new ControlDrainPoller(controlChannel, controlHandlers);
  // The drain runs in the gateway only: two would spawn every delegated
  // task twice. An attached TUI's console enqueues; the gateway drains.
  if (!attach) controlPoller.start();

  // Autonomous loop watchdog — periodically scan delegations where
  // the peer's output arrived but the initiator hasn't followed up.
  // Push a chat nudge per row; after `maxNudges` consecutive nudges
  // without an initiator reaction, escalate to the user. Checked
  // every 15s — tighter than the 30s default threshold so a nudge
  // doesn't have to wait a full extra interval after it becomes
  // due.
  //
  // Quiet when neither Telegram credentials are configured nor
  // there's anywhere to send the nudge: the row stays awaiting,
  // watchdog wakes again next tick.
  const nudgeBotToken = secretStore.exists("telegram-bot-token")
    ? secretStore.get("telegram-bot-token")
    : undefined;
  const nudgeChatId = secretStore.exists("telegram-chat-id")
    ? secretStore.get("telegram-chat-id")
    : undefined;
  if (!attach) watchdogTimer = setInterval(() => {
    void runDelegationWatchdog({
      tracker: delegationTracker,
      telegramBotToken: nudgeBotToken,
      telegramChatId: nudgeChatId,
    }).catch((err) => {
      process.stderr.write(
        `foreman: delegation watchdog tick failed: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    });
  }, 15_000);
  // Avoid keeping Node alive purely on the timer when the rest of
  // the process is winding down (e.g. CLI test runners) — the
  // signal handler at the top of run() handles graceful exit.
  watchdogTimer?.unref();

  const channels = notificationSetup?.channelIds ?? [];
  if (headless) {
    const reach = channels.length > 0 ? channels.join(", ") : "none (notify.yaml has no working channel)";
    headless.log(`gateway running (pid ${process.pid}): approvals and notifications go to ${reach}`);
  }

  return {
    registry,
    audit,
    approval,
    policy,
    mediator,
    sessionManager,
    publicKey,
    bootInfo,
    mode,
    channels,
    waitForExit,
    shutdown,
  };
}

// Best-effort OOB bridge setup. Returns the bridge if the config is sane and
// at least one channel could be built; null if there's nothing to do. Each
// failure mode (no notify.yaml, channel disabled, secret missing) is silent
// so the TUI keeps working on its own.
// Construct an LlmVerifier when the user has opted into verification AND
// the configured provider's credentials resolve. Returns null otherwise —
// the mediator keeps working with heuristic-only behavior. Every failure
// mode is silent so a bad LLM config can't crash boot.
function setupSummaryLlmClient(args: {
  secretStore: SecretStore;
  llmConfigPath: string;
}): import("../core/llm/client.js").LlmClient | null {
  // Smart summary (#306) reuses the configured provider; gated on the
  // `smart_report` feature flag so verification + summary can be toggled
  // independently. Failures are silent — the digest falls back to the
  // template body.
  let config;
  try {
    config = loadLlmConfig(args.llmConfigPath);
  } catch {
    return null;
  }
  if (!isFeatureEnabled(config, "smart_report")) return null;
  try {
    return buildLlmClient(config, args.secretStore);
  } catch (err) {
    if (
      err instanceof LlmProviderUnavailableError ||
      err instanceof LlmCredentialMissingError ||
      err instanceof LlmOAuthLoginRequiredError
    ) {
      // OAuth configured but not logged in yet (e.g. `codex login` /
      // `foreman llm login openai` not completed) is the same category as a
      // missing credential: skip the optional LLM feature and keep running
      // heuristic-only instead of crashing `foreman start`.
      return null;
    }
    throw err;
  }
}

function setupLlmVerifier(args: {
  db: ReturnType<typeof getDb>;
  secretStore: SecretStore;
  llmConfigPath: string;
}): LlmVerifier | null {
  let config;
  try {
    config = loadLlmConfig(args.llmConfigPath);
  } catch {
    return null;
  }
  if (!isFeatureEnabled(config, "verification")) return null;

  // Factory dispatches across all providers (#296). Missing credentials (or
  // an unset / invalid ollama / openai_compatible base URL) surface as typed
  // errors; the mediator keeps working with heuristic-only behavior, so we
  // swallow them silently here.
  try {
    const client = buildLlmClient(config, args.secretStore);
    return new LlmVerifier({ db: args.db, config, client });
  } catch (err) {
    if (
      err instanceof LlmProviderUnavailableError ||
      err instanceof LlmCredentialMissingError ||
      err instanceof LlmOAuthLoginRequiredError
    ) {
      // OAuth configured but not logged in yet (e.g. `codex login` /
      // `foreman llm login openai` not completed) is the same category as a
      // missing credential: skip the optional LLM feature and keep running
      // heuristic-only instead of crashing `foreman start`.
      return null;
    }
    throw err;
  }
}

/** Slack / Discord bot tokens from notify.yaml, for the comms mirror. */
function chatBotTokens(
  notifyConfigPath: string,
  secretStore: SecretStore,
): { slack: string | null; discord: string | null } {
  const token = (channel: "slack" | "discord"): string | null => {
    try {
      const ref = channelConfig(
        loadNotifyConfig(notifyConfigPath),
        channel,
      )?.bot_token_ref;
      return ref && secretStore.exists(ref) ? secretStore.get(ref) : null;
    } catch {
      return null;
    }
  };
  return { slack: token("slack"), discord: token("discord") };
}

function setupNotificationBridge(args: {
  db: ReturnType<typeof getDb>;
  secretStore: SecretStore;
  notifyConfigPath: string;
  notifyStatePath: string;
  llmConfigPath: string;
  onChannelWarning?: (message: string) => void;
  onChatCommand?: (
    channel: "slack" | "discord" | "telegram",
    text: string,
    userId: string,
  ) => Promise<string>;
  onChannelDecision?: NotificationBridgeOptions["onChannelDecision"];
  onInteractionRefused?: InteractionRefusalSink;
  /** Chat agents that may read the Telegram bot (agentsSharingTelegram). */
  telegramSharedWith?: string[];
}): {
  bridge: NotificationBridge;
  scheduler: DailyScheduler | null;
  service: NotificationService;
  channelIds: string[];
} | null {
  let config;
  try {
    config = loadNotifyConfig(args.notifyConfigPath);
  } catch {
    return null;
  }

  // One factory for every channel type (Slack, Discord, email and ntfy
  // included) — the same one `foreman notify test` uses. Misconfigured
  // channels are skipped here and reported by `foreman doctor`.
  const { channels } = buildEnabledChannels(config, {
    secrets: args.secretStore,
    // Buttons carry HMAC-tagged approval ids so the relaying chat agent
    // cannot approve a call the user never tapped.
    signApproval: approvalSigner(loadOrCreateSecretsMasterKey()),
    // Buttons Foreman receives itself get their own key (never a relay token).
    signButton: approvalButtonSigner(loadOrCreateSecretsMasterKey()),
    ...(args.onChannelWarning
      ? { onChannelWarning: args.onChannelWarning }
      : {}),
    ...(args.onChatCommand ? { onChatCommand: args.onChatCommand } : {}),
    ...(args.onInteractionRefused
      ? { onInteractionRefused: args.onInteractionRefused }
      : {}),
    ...(args.telegramSharedWith ? { telegramSharedWith: args.telegramSharedWith } : {}),
  });

  if (channels.size === 0) return null;

  const service = new NotificationService({ db: args.db, config, channels });
  // Bridge re-reads notify-state.json on every dispatch so silence / mute
  // changes (CLI: `foreman notify silence 4h`) take effect without a restart.
  const bridge = new NotificationBridge(service, {
    bus,
    getState: () => loadNotifyState(args.notifyStatePath),
    // Which person on which channel decided: the approval row itself only
    // records "the user".
    ...(args.onChannelDecision
      ? { onChannelDecision: args.onChannelDecision }
      : {}),
  });
  void bridge.start().catch(() => {
    /* best-effort */
  });

  // C10 / #233 — turn `llm:budget-alert` bus events into OOB notifications
  // through the same channels as everything else (system/telegram/webhook).
  // The bridge tears down with the rest of the start lifecycle.
  const budgetAlertBridge = new BudgetAlertBridge({ bus, notify: service });
  budgetAlertBridge.start();

  // Daily digest — fires on the configured schedule via every channel in the
  // summary route. C11c only; no-op when routing.summary.schedule is unset
  // or the schedule string doesn't parse.
  let scheduler: DailyScheduler | null = null;
  const summaryRoute = routeFor(config, "summary");
  if (summaryRoute.schedule && summaryRoute.channels.length > 0) {
    const parsed = parseSchedule(summaryRoute.schedule);
    if (parsed) {
      // #306 — smart summary. When LLM smart_report is enabled the digest
      // becomes a contextual narrative; otherwise the existing template
      // body is sent. The fallback path is automatic — see
      // generateSmartSummaryPayload.
      const summaryClient = setupSummaryLlmClient({
        secretStore: args.secretStore,
        llmConfigPath: args.llmConfigPath,
      });
      scheduler = new DailyScheduler(parsed, async () => {
        const payload = await generateSmartSummaryPayload(args.db, {
          llmClient: summaryClient,
        });
        try {
          await service.send("summary", payload);
        } catch {
          /* best-effort — failure already persisted in `notifications` */
        }
      });
      scheduler.start();
    }
  }

  return { bridge, scheduler, service, channelIds: [...channels.keys()] };
}

// =============================================================================
// #435 — Activity summary daily scheduler
// =============================================================================
//
// Off-by-default cousin of the existing daily-digest scheduler. Reads
// notify.yaml `routing.activity_summary` for the schedule + channels.
// On fire: build the digest, narrate via Foreman LLM (orchestrator_chat
// feature flag must be on), ship via ForemanVoice.sendProactive so
// quiet-hours + throttle apply.

function setupActivitySummaryScheduler(args: {
  db: ForemanDb;
  registry: RegistryService;
  secretStore: SecretStore;
  llmConfigPath: string;
  notifyConfigPath: string;
  voice: ForemanVoice;
}): DailyScheduler | null {
  let notifyConfig;
  try {
    notifyConfig = existsSync(args.notifyConfigPath)
      ? loadNotifyConfig(args.notifyConfigPath)
      : null;
  } catch {
    return null;
  }
  const route = notifyConfig?.routing.activity_summary;
  if (!route || route.channels.length === 0 || !route.schedule) {
    return null;
  }
  const parsed = parseSchedule(route.schedule);
  if (!parsed) return null;

  const scheduler = new DailyScheduler(parsed, async () => {
    let llmConfig;
    try {
      llmConfig = existsSync(args.llmConfigPath)
        ? loadLlmConfig(args.llmConfigPath)
        : null;
    } catch {
      return;
    }
    if (!llmConfig || !isFeatureEnabled(llmConfig, "orchestrator_chat")) {
      // Daily summary requires the LLM narration path — silently no-op
      // when disabled instead of pinging the user with a blank digest.
      return;
    }
    const digest = buildAgentActivityDigest(args.db, args.registry, {
      windowMinutes: 24 * 60,
    });
    let client;
    try {
      client = buildLlmClient(llmConfig, args.secretStore);
    } catch {
      return;
    }
    const prompt = buildActivityPrompt({ digest });
    try {
      const resp = await client.call(prompt, {
        feature: "orchestrator_chat",
        maxTokens: 350,
        temperature: 0.3,
      });
      recordUsageAndCheckBudget(args.db, llmConfig, {
        provider: client.providerId,
        model: client.model,
        feature: "orchestrator_chat",
        inputTokens: resp.inputTokens,
        outputTokens: resp.outputTokens,
        costUsd: resp.costUsd,
        durationMs: resp.durationMs,
        cacheHit: resp.cacheHit,
      });
      const text = resp.text.trim();
      if (text.length === 0) return;
      await args.voice.sendProactive({
        type: "daily_summary",
        urgency: "info",
        title: "Foreman daily activity",
        body: text,
        actions: [],
      });
    } catch {
      /* best-effort — failure logged via the LLM debug channel */
    }
  });
  scheduler.start();
  return scheduler;
}

const AGENT_TOKENS_INBOX_KEY = "identity:agent-tokens";

/** #618 — Agents without their identity token run untrusted on the MCP
 *  path. Raised on every start (as unread) until `foreman agent rewire`
 *  fixes it; best-effort, it never blocks the boot. */
function warnAboutAgentTokens(
  registry: RegistryService,
  secretStore: SecretStore,
  inbox: InboxService,
  withTui: boolean,
): void {
  try {
    let doc: ReturnType<typeof loadActiveRegistry>["doc"] | null = null;
    try {
      doc = loadActiveRegistry().doc;
    } catch {
      doc = null;
    }
    const audit = auditAgentTokens(
      registry.listAll(),
      secretStore,
      (id) => doc?.agents.find((a) => a.id === id) ?? null,
    );
    const problem = describeTokenAudit(audit);
    if (!problem) {
      inbox.markKeyRead(AGENT_TOKENS_INBOX_KEY);
      return;
    }
    inbox.upsert({
      level: "warning",
      kind: "system",
      title: "Some agents can't prove their identity to Foreman",
      body: `${problem.message}. ${problem.remediation}`,
      dedupeKey: AGENT_TOKENS_INBOX_KEY,
    });
    if (!withTui) {
      process.stderr.write(
        `${orange("warning: ")}${problem.message}\n  → ${problem.remediation}\n`,
      );
    }
  } catch {
    /* doctor reports the same problem */
  }
}

// Returns true when the user appears to be a first-time user: no foreman home
// or no registered agents. Triggers the auto-onboarding flow.
function looksLikeFreshInstall(): boolean {
  const paths = getForemanPaths();
  if (!existsSync(paths.root) || !existsSync(paths.identityPath)) {
    return true;
  }
  try {
    const db = getDb();
    const registry = new RegistryService(db, bus);
    const count = registry.list().length;
    closeDb();
    return count === 0;
  } catch {
    closeDb();
    return true;
  }
}

function seedHomeIfMissing(): void {
  const paths = getForemanPaths();
  if (existsSync(paths.root) && existsSync(paths.identityPath)) return;
  console.log(
    `${orange(bold("Foreman"))} ${dim("— seeding home with defaults…")}`,
  );
  runInit({});
  console.log(`${green("✓")} initialised at ${paths.root}\n`);
}

/** Runs the setup wizard. Resolves true when the user quit it (Ctrl-C, or
 *  [q] on Welcome) instead of finishing — the caller must then exit rather
 *  than launch the TUI. */
async function runOnboardingWizard(): Promise<boolean> {
  const paths = getForemanPaths();
  if (!existsSync(paths.root) || !existsSync(paths.identityPath)) {
    seedHomeIfMissing();
  } else {
    console.log(
      `${orange(bold("Foreman"))} ${dim("— no agents yet, starting setup wizard…")}\n`,
    );
  }
  // Same pre-flight as `foreman setup` (#276) — refuse before mounting Ink
  // if the registry can't be parsed, so the user sees a friendly error
  // instead of a React stacktrace.
  try {
    loadActiveRegistry();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(red("error: ") + detail);
    console.error("  → Run `foreman registry validate` to inspect.");
    console.error(
      "  → Run `foreman registry update --force` if the cached copy is stale.",
    );
    console.error("  → Or reinstall: npm install -g foreman-agent@latest");
    process.exit(1);
  }
  const db = getDb();
  const registry = new RegistryService(db, bus);
  const secretStore = new SecretStore(db, loadOrCreateSecretsMasterKey());
  const chatPrimary = new ChatPrimaryService(db, { bus });
  const wizardInt = wizardIntegrations(db, secretStore);
  // #468 — Auto-spawn OAuth flow queue. See setup.ts for the same wiring;
  // the wizard's [y] hotkey hands its OAuth steps here and we run them
  // post-unmount so interactive stdio reaches the child cleanly.
  const oauthQueue: WizardOauthRunStep[] = [];
  let quit = false;
  const instance = render(
    React.createElement(SetupWizard, {
      initialState: loadSetupState() ?? freshState(),
      services: {
        db,
        secretStore,
        registry,
        chatPrimary,
        policyPath: paths.policyPath,
        llmConfigPath: paths.llmConfigPath,
        notifyConfigPath: paths.notifyConfigPath,
        voiceConfigPath: paths.voiceConfigPath,
        launchEditor,
        requestOauthRun: (steps) => {
          oauthQueue.push(...steps);
        },
        ...(wizardInt.integrations ? { integrations: wizardInt.integrations } : {}),
      },
      // `foreman start` continues into the TUI once the wizard exits.
      afterExit: "launch-tui",
      onQuit: (reason) => {
        quit = true;
        if (reason === "interrupt") process.exitCode = 130;
      },
    }),
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
  wizardInt.dispose();
  if (oauthQueue.length > 0) {
    runOauthFlows(oauthQueue);
  }
  closeDb();
  return quit;
}

/** `--skip-setup` is the prompt's [s] as a flag, and like [s] it is
 *  remembered, so later runs don't ask again (#657). A setup already
 *  started or finished is left as it is. */
export function rememberSetupSkipped(): void {
  const state = loadSetupState();
  if (!hasUserOptedOut(state)) saveSetupState(markSetupSkipped(state));
}

/** Slack / Discord: may this sender change integrations from chat? The
 *  channel's owner_user_ids when set, else its allowed_user_ids (already
 *  checked by the channel). The Telegram approval bot only takes commands
 *  from your own private chat, so it always may. A notify.yaml that can't
 *  be read closes it. */
export function isIntegrationOwner(notifyConfigPath: string, channel: string, userId: string): boolean {
  if (channel === "telegram") return true;
  try {
    const toggle = channelConfig(loadNotifyConfig(notifyConfigPath), channel as "slack" | "discord");
    const owners = toggle?.owner_user_ids;
    return owners ? owners.includes(userId) : (toggle?.allowed_user_ids ?? []).includes(userId);
  } catch {
    return false;
  }
}

/** The Integrations page's service; the TUI still starts when the bundled
 *  catalog can't be read (the page then says integrations are unavailable). */
function integrationsForTui(
  store: SecretStore,
  audit: IntegrationAuditSink,
): { integrations?: IntegrationWiring } {
  try {
    return { integrations: createIntegrationWiring({ paths: getForemanPaths(), store, audit }) };
  } catch {
    return {};
  }
}

export type StartChoice = "setup" | "skip" | "quit";

// Maps an answer line (trimmed, lowercased) to a fresh-install choice.
// Empty input + 'y' default to running setup (Enter is the affordance shown
// in the prompt). 's' / 'q' are explicit single-letter shortcuts.
export function parseStartChoice(answer: string): StartChoice {
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "q") return "quit";
  if (trimmed === "s") return "skip";
  return "setup";
}

async function promptStartChoice(): Promise<StartChoice> {
  if (!process.stdin.isTTY) return "skip";
  process.stderr.write(
    `\n${orange(bold("Foreman"))} ${dim("— not configured yet.")}\n\n` +
      `  Recommended: run ${bold("foreman setup")} (5-minute wizard)\n` +
      `  Or:          relaunch with ${bold("--skip-setup")} for defaults only\n\n` +
      `  [Enter] Run setup now\n` +
      `  [s]     Skip and launch with defaults\n` +
      `  [q]     Quit\n\n` +
      `> `,
  );
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return readStartChoice(rl);
}

/**
 * One answer from the first-run prompt. Ctrl-C quits with exit code 130,
 * like any interrupted command; without the handler readline swallowed it,
 * nothing was left to run and Node exited 13 with an "unsettled top-level
 * await" warning. Ctrl-D (end of input) quits too instead of hanging.
 */
export function readStartChoice(rl: ReadlineInterface): Promise<StartChoice> {
  return new Promise<StartChoice>((resolveChoice) => {
    let answered = false;
    rl.question("", (answer) => {
      answered = true;
      rl.close();
      resolveChoice(parseStartChoice(answer));
    });
    rl.on("SIGINT", () => {
      process.exitCode = 130;
      process.stderr.write("\n");
      rl.close();
    });
    rl.on("close", () => {
      if (!answered) resolveChoice("quit");
    });
  });
}

// =============================================================================
// Delegation watchdog — runs on a 15s timer (see runForeman above).
// Pulls pending nudges from the tracker + posts each to Telegram.
// Pure helper so unit tests can drive it deterministically.
// =============================================================================

const TELEGRAM_API_URL = "https://api.telegram.org";

export interface DelegationWatchdogDeps {
  tracker: DelegationTracker;
  telegramBotToken?: string | undefined;
  telegramChatId?: string | undefined;
  /** Override the network call for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override the clock for tests. Defaults to Date.now via the tracker. */
  nowMs?: () => number;
}

/**
 * One tick of the watchdog: query pending nudges, push each one to
 * Telegram, record the nudge (or escalation if past max). Returns the
 * count of nudges + escalations dispatched for observability +
 * test assertions.
 */
export async function runDelegationWatchdog(
  deps: DelegationWatchdogDeps,
): Promise<{ nudged: number; escalated: number }> {
  const pending = deps.tracker.pendingNudges();
  let nudged = 0;
  let escalated = 0;
  if (pending.length === 0) return { nudged, escalated };

  // No chat configured → record-only mode: the tracker still flips
  // status awaiting → nudged so the row doesn't sit forever, but no
  // outbound message is dispatched. Operator can see the state via
  // the CLI (PR B adds `foreman delegations list`).
  const canPush = Boolean(deps.telegramBotToken && deps.telegramChatId);
  for (const row of pending) {
    // Initiators that aren't LLM agents (e.g. `cli` for terminal users)
    // have nothing to nudge — they SEE the output in their own context.
    if (isHumanSource(row.initiatorAgent)) continue;

    const isLastNudge = row.nudgeCount + 1 >= deps.tracker.maxNudges;
    const text = isLastNudge
      ? composeEscalationText(row)
      : composeNudgeText(row);

    if (canPush) {
      try {
        await pushTelegramNudge({
          text,
          botToken: deps.telegramBotToken!,
          chatId: deps.telegramChatId!,
          fetchImpl: deps.fetchImpl,
        });
      } catch (err) {
        process.stderr.write(
          `foreman: nudge push failed for ${row.id}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
        // Keep going — DB state still advances so we don't spin on
        // the same row forever.
      }
    }

    if (isLastNudge) {
      deps.tracker.recordEscalation(row.id);
      escalated += 1;
    } else {
      deps.tracker.recordNudge(row.id);
      nudged += 1;
    }
  }
  return { nudged, escalated };
}

interface PushTelegramNudgeInput {
  text: string;
  botToken: string;
  chatId: string;
  fetchImpl?: typeof fetch;
}

async function pushTelegramNudge(input: PushTelegramNudgeInput): Promise<void> {
  const fetchFn = input.fetchImpl ?? fetch;
  const url = `${TELEGRAM_API_URL}/bot${input.botToken}/sendMessage`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: input.chatId,
      text: input.text,
      // Plain text — keep parse-mode off so the message renders
      // regardless of markdown characters in the prompt summary.
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Telegram sendMessage ${res.status}: ${body.slice(0, 300)}`,
    );
  }
}

export const startCommand = new Command("start")
  .description("Start the Foreman gateway with the Ink TUI")
  .option(
    "--no-onboarding",
    "skip the auto setup prompt even when the foreman home is fresh",
  )
  .option(
    "--skip-setup",
    "launch with default policy only, recording the choice so future runs don't re-prompt",
  )
  .action(async (options: { onboarding?: boolean; skipSetup?: boolean }) => {
    // The dashboard is an Ink TUI — rendering it against a non-TTY pipe
    // dumps escape-code soup into stdout and the interactive event loop
    // never exits (CI hangs forever). Match `foreman setup`'s guard and
    // refuse upfront with scripted alternatives (#278).
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error(
        red("error: ") +
          "foreman start requires an interactive terminal — the TUI cannot render to a pipe.",
      );
      console.error("  → Run it directly in a terminal.");
      console.error(
        "  → Or use `foreman mcp-stdio` (machine-readable) / `foreman wrap <cmd>` (audited subprocess) for scripted contexts.",
      );
      process.exit(1);
    }
    const flagSkip = options.onboarding === false || options.skipSetup;
    if (!flagSkip && looksLikeFreshInstall()) {
      const previousState = loadSetupState();
      if (!hasUserOptedOut(previousState)) {
        const choice = await promptStartChoice();
        if (choice === "setup") {
          // Quitting the wizard quits Foreman; only a finished setup goes
          // on to launch the TUI.
          // process.exit() keeps the 130 a Ctrl-C quit set.
          if (await runOnboardingWizard()) process.exit();
        } else if (choice === "skip") {
          seedHomeIfMissing();
          saveSetupState(markSetupSkipped(previousState));
        } else {
          // process.exit() keeps the 130 a Ctrl-C at the prompt set.
          process.exit();
        }
      } else {
        // Already configured / previously skipped — seed home if it's
        // missing so startForeman() doesn't throw NotInitialisedError on
        // a fresh box that flag-skipped before.
        seedHomeIfMissing();
      }
    } else if (flagSkip) {
      // --no-onboarding / --skip-setup needs the home to exist.
      seedHomeIfMissing();
      if (options.skipSetup) rememberSetupSkipped();
    }
    // The background service's headless gateway owns this home: this
    // window is its TUI (approvals, inbox, logs, console), nothing more.
    const configDir = getForemanPaths().configDir;
    let started: StartedForeman;
    try {
      const gateway = attachedGatewayState(configDir);
      started = gateway ? startForeman({ attach: gateway }) : startForeman();
    } catch (err) {
      // The service took the home between the check and the lock.
      const gateway = err instanceof ForemanAlreadyRunningError ? attachedGatewayState(configDir) : null;
      if (gateway) {
        closeDb();
        started = startForeman({ attach: gateway });
      } else if (err instanceof NotInitialisedError) {
        console.error(
          red("error: ") +
            `${err.message} Tip: run 'foreman setup' to configure interactively, or 'foreman init' to seed the home and use defaults.`,
        );
        process.exit(1);
      } else if (err instanceof PolicyLoadError) {
        printPolicyLoadError(err);
        closeDb();
        process.exit(1);
      } else if (err instanceof ForemanAlreadyRunningError) {
        console.error(red("error: ") + err.message);
        closeDb();
        process.exit(1);
      } else {
        throw err;
      }
    }
    await started.waitForExit();
    await started.shutdown();
    if (started.mode === "attached") {
      // Quitting the TUI leaves the gateway (and its channels) running.
      console.log(dim("Foreman keeps guarding in the background (`foreman service status`)."));
    }
  });

/** The live headless gateway that owns this home, if any. */
export function attachedGatewayState(configDir: string): { pid: number } | null {
  const gateway: GatewayProbe = probeGateway(configDir);
  return gateway.state === "running" && gateway.mode === "headless" ? { pid: gateway.pid } : null;
}

/** Registered chat agents that may read the Telegram bot's updates; when
 *  there are none, Foreman reads them (telegram-listener.ts). */
function telegramSharedWith(registry: RegistryService): string[] {
  try {
    return agentsSharingTelegram(registry.listAll(), loadActiveRegistry().doc.agents);
  } catch {
    // Without the catalog we can't tell: assume an agent may share the bot,
    // so Foreman never fights it for updates.
    return ["unknown"];
  }
}
