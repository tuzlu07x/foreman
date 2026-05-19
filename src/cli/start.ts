import { existsSync } from "node:fs";
import { Command } from "commander";
import { render, type Instance } from "ink";
import React from "react";
import {
  ApprovalBridge,
  BusApprovalService,
  ReadlineApprovalService,
  type ApprovalService,
} from "../core/approval.js";
import { AgentDaemonManager } from "../core/agent-daemon-manager.js";
import { AuditLogger } from "../core/audit.js";
import { bus } from "../core/event-bus.js";
import { MediatorService } from "../core/mediator.js";
import { PolicyEngine } from "../core/policy-engine.js";
import { ChatPrimaryService } from "../core/chat-primary.js";
import {
  deleteForemanPidfile,
  writeForemanPidfile,
} from "../core/foreman-pidfile.js";
import { RegistryService } from "../core/registry.js";
import { RiskScorer } from "../core/risk-scorer.js";
import { SessionManager } from "../core/session.js";
import { checkAgentUpdates } from "../core/agent-update-check.js";
import { loadActiveRegistry } from "../core/registry-catalog.js";
import { checkForUpdate } from "../core/update-check.js";
import { closeDb, getDb, getSqlite } from "../db/client.js";
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
import { SetupWizard } from "../tui/setup-wizard.js";
import { SecretStore, SecretNotFoundError } from "../core/secret-store.js";
import { loadOrCreateSecretsMasterKey } from "../identity/master-key.js";
import { isFeatureEnabled, loadLlmConfig } from "../core/llm/config.js";
import {
  buildLlmClient,
  LlmCredentialMissingError,
  LlmProviderUnavailableError,
} from "../core/llm/factory.js";
import { LlmVerifier } from "../core/llm/verifier.js";
import { TelegramChannel } from "../core/notification/channels/telegram.js";
import { SystemNotifyChannel } from "../core/notification/channels/system.js";
import { WebhookChannel } from "../core/notification/channels/webhook.js";
import { BudgetAlertBridge } from "../core/llm/budget-alert-bridge.js";
import { NotificationBridge } from "../core/notification/notification-bridge.js";
import { NotificationService } from "../core/notification/notification-service.js";
import { ForemanVoice } from "../core/notification/foreman-voice.js";
import {
  loadVoiceConfig,
  type VoiceConfig,
} from "../core/notification/voice-config.js";
import { PatternDetectionService } from "../core/pattern-detection-service.js";
import {
  channelConfig,
  isChannelEnabled,
  loadNotifyConfig,
  routeFor,
} from "../core/notification/notify-config.js";
import { loadNotifyState } from "../core/notification/notify-state.js";
import { DailyScheduler, parseSchedule } from "../core/notification/scheduler.js";
import { generateSmartSummaryPayload } from "../core/notification/summary-generator.js";
import type {
  ChannelId,
  NotificationChannel,
} from "../core/notification/types.js";
import { launchEditor } from "../tui/launch-editor.js";
import { getForemanPaths } from "../utils/config.js";
import { runInit } from "./init.js";
import { bold, dim, green, orange, red } from "./colors.js";

const APP_VERSION = "0.1.0";

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
  waitForExit: () => Promise<void>;
  shutdown: () => Promise<void>;
}

export interface StartForemanOptions {
  /** Skip mounting the Ink TUI. Tests use this to avoid touching stdout. */
  withTui?: boolean;
}

export function startForeman(
  options: StartForemanOptions = {},
): StartedForeman {
  const paths = getForemanPaths();
  if (!existsSync(paths.root) || !existsSync(paths.identityPath)) {
    throw new NotInitialisedError(paths.root);
  }
  // #431 — Write the start.ts PID to a pidfile so `foreman mcp-stdio`
  // can signal us when a user types `/foreman stop` into an agent's
  // Telegram chat. Cleanup happens in shutdown().
  writeForemanPidfile(paths.configDir);
  const { publicKey } = loadOrCreateMasterKey();
  const db = getDb();
  const sqlite = getSqlite();
  const registry = new RegistryService(db, bus);
  const audit = new AuditLogger(db, bus);
  const secretStore = new SecretStore(db, loadOrCreateSecretsMasterKey());
  const withTui = options.withTui ?? true;
  const approval: ApprovalService = withTui
    ? new BusApprovalService({ bus })
    : new ReadlineApprovalService({ bus });
  const policy = new PolicyEngine(db, bus);
  if (existsSync(paths.policyPath)) policy.loadFromYaml(paths.policyPath);
  // #349 — auto-launch every registered agent that declares a `daemon` block
  // in registry/agents.json (Hermes gateway, OpenClaw daemon, etc). Interactive
  // agents (Codex, Claude Code) have `daemon: null` and are skipped silently;
  // the TUI surfaces them as "interactive — launch manually".
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
  daemonManager.startAll();
  const risk = new RiskScorer(db, undefined, {
    bucketOverrides: () => policy.getBucketOverrides(),
    // Wire the responsibility-violation rule (#300). Both lookups close
    // over `registry` + `policy` so a YAML reload or agent edit shows up
    // on the next request without rebuilding the scorer.
    getAgentResponsibility: (agentId) =>
      registry.get(agentId)?.responsibilityNote ?? null,
    responsibilityPolicies: () => policy.getResponsibilityPolicies(),
  });
  const sessionManager = new SessionManager(db, { bus });
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
  const approvalBridge = new ApprovalBridge(db, { bus });
  approvalBridge.start();

  // OOB notification bridge (#235 / C11a-2). Best-effort: any failure here
  // (notify.yaml malformed, secret missing, etc.) is logged but does NOT
  // block start — the TUI modal still works on its own.
  const notificationSetup = setupNotificationBridge({
    db,
    secretStore,
    notifyConfigPath: paths.notifyConfigPath,
    notifyStatePath: paths.notifyStatePath,
    llmConfigPath: paths.llmConfigPath,
  });
  const notificationBridge = notificationSetup?.bridge ?? null;
  const dailyScheduler = notificationSetup?.scheduler ?? null;

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
          voiceConfig.proactive_notifications.pattern_detection.cooldown_minutes *
          60_000,
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
        },
      }),
      { exitOnCtrlC: false },
    );
  } else {
    keepAlive = setInterval(() => {}, 1 << 30);
  }

  const waitForExit = (): Promise<void> => {
    if (instance) return instance.waitUntilExit();
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
    if (exitResolve) {
      const r = exitResolve;
      exitResolve = null;
      r();
    }
    approvalBridge.stop();
    if (dailyScheduler) dailyScheduler.stop();
    if (patternDetector) patternDetector.stop();
    if (voice) voice.dispose();
    if (notificationBridge) {
      await notificationBridge.stop().catch(() => {
        /* best-effort cleanup */
      });
    }
    // SIGTERM every tracked agent daemon, wait up to 5s, then SIGKILL.
    // Awaited so foreman doesn't exit with stranded children.
    await daemonManager.stopAll().catch(() => {
      /* best-effort cleanup */
    });
    audit.dispose();
    deleteForemanPidfile(paths.configDir);
    closeDb();
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

  return {
    registry,
    audit,
    approval,
    policy,
    mediator,
    sessionManager,
    publicKey,
    bootInfo,
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
      err instanceof LlmCredentialMissingError
    ) {
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

  // Factory dispatches across all implemented providers (#296). Unimplemented
  // providers (ollama, openai_compatible — v0.2 #312) and missing credentials
  // both surface as typed errors; either way the mediator keeps working with
  // heuristic-only behavior, so we swallow them silently here.
  try {
    const client = buildLlmClient(config, args.secretStore);
    return new LlmVerifier({ db: args.db, config, client });
  } catch (err) {
    if (
      err instanceof LlmProviderUnavailableError ||
      err instanceof LlmCredentialMissingError
    ) {
      return null;
    }
    throw err;
  }
}

function setupNotificationBridge(args: {
  db: ReturnType<typeof getDb>;
  secretStore: SecretStore;
  notifyConfigPath: string;
  notifyStatePath: string;
  llmConfigPath: string;
}): {
  bridge: NotificationBridge;
  scheduler: DailyScheduler | null;
  service: NotificationService;
} | null {
  let config;
  try {
    config = loadNotifyConfig(args.notifyConfigPath);
  } catch {
    return null;
  }

  const channels = new Map<ChannelId, NotificationChannel>();

  if (isChannelEnabled(config, "telegram")) {
    const tg = channelConfig(config, "telegram");
    if (tg?.bot_token_ref && tg.chat_id) {
      try {
        const token = args.secretStore.get(tg.bot_token_ref);
        channels.set(
          "telegram",
          new TelegramChannel({ botToken: token, chatId: tg.chat_id }),
        );
      } catch (err) {
        if (!(err instanceof SecretNotFoundError)) throw err;
        // Token wasn't in the store — skip Telegram quietly. User will see
        // the misconfiguration via `foreman doctor` / `foreman notify test`.
      }
    }
  }

  if (isChannelEnabled(config, "webhook")) {
    const wh = channelConfig(config, "webhook");
    if (wh?.webhook_url_ref) {
      try {
        const url = args.secretStore.get(wh.webhook_url_ref);
        const signingSecret = wh.signing_secret_ref
          ? args.secretStore.get(wh.signing_secret_ref)
          : undefined;
        channels.set("webhook", new WebhookChannel({ url, signingSecret }));
      } catch (err) {
        if (!(err instanceof SecretNotFoundError)) throw err;
      }
    }
  }

  if (isChannelEnabled(config, "system")) {
    const sys = new SystemNotifyChannel();
    // isReady is async — skip the await because the failure mode is "send
    // throws on unsupported platforms" and we want to keep setup synchronous.
    channels.set("system", sys);
  }

  if (channels.size === 0) return null;

  const service = new NotificationService({ db: args.db, config, channels });
  // Bridge re-reads notify-state.json on every dispatch so silence / mute
  // changes (CLI: `foreman notify silence 4h`) take effect without a restart.
  const bridge = new NotificationBridge(service, {
    bus,
    getState: () => loadNotifyState(args.notifyStatePath),
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

  return { bridge, scheduler, service };
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

async function runOnboardingWizard(): Promise<void> {
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
    const detail =
      err instanceof Error ? err.message : String(err);
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
      },
    }),
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
  closeDb();
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
  return new Promise<StartChoice>((resolveChoice) => {
    rl.question("", (answer) => {
      rl.close();
      resolveChoice(parseStartChoice(answer));
    });
  });
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
  .action(
    async (options: { onboarding?: boolean; skipSetup?: boolean }) => {
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
            await runOnboardingWizard();
          } else if (choice === "skip") {
            seedHomeIfMissing();
            saveSetupState(markSetupSkipped(previousState));
          } else {
            process.exit(0);
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
      }
      let started: StartedForeman;
      try {
        started = startForeman();
      } catch (err) {
        if (err instanceof NotInitialisedError) {
          console.error(
            red("error: ") +
              `${err.message} Tip: run 'foreman setup' to configure interactively, or 'foreman init' to seed the home and use defaults.`,
          );
          process.exit(1);
        }
        throw err;
      }
      await started.waitForExit();
      await started.shutdown();
    },
  );
