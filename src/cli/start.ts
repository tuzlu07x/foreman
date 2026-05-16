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
import { AuditLogger } from "../core/audit.js";
import { bus } from "../core/event-bus.js";
import { MediatorService } from "../core/mediator.js";
import { PolicyEngine } from "../core/policy-engine.js";
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
import { TelegramChannel } from "../core/notification/channels/telegram.js";
import { SystemNotifyChannel } from "../core/notification/channels/system.js";
import { WebhookChannel } from "../core/notification/channels/webhook.js";
import { NotificationBridge } from "../core/notification/notification-bridge.js";
import { NotificationService } from "../core/notification/notification-service.js";
import {
  channelConfig,
  isChannelEnabled,
  loadNotifyConfig,
} from "../core/notification/notify-config.js";
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
  const risk = new RiskScorer(db, undefined, {
    bucketOverrides: () => policy.getBucketOverrides(),
  });
  const sessionManager = new SessionManager(db, { bus });
  const mediator = new MediatorService({
    registry,
    policy,
    risk,
    approval,
    sessionManager,
    db,
    bus,
  });

  // Surface pending approvals from spawned `foreman mcp-stdio` / `foreman
  // wrap` processes into this process's bus, so the TUI's approval modal
  // fires for cross-process requests too (#117).
  const approvalBridge = new ApprovalBridge(db, { bus });
  approvalBridge.start();

  // OOB notification bridge (#235 / C11a-2). Best-effort: any failure here
  // (notify.yaml malformed, secret missing, etc.) is logged but does NOT
  // block start — the TUI modal still works on its own.
  const notificationBridge = setupNotificationBridge({
    db,
    secretStore,
    notifyConfigPath: paths.notifyConfigPath,
  });

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
    if (notificationBridge) {
      await notificationBridge.stop().catch(() => {
        /* best-effort cleanup */
      });
    }
    audit.dispose();
    closeDb();
  };

  process.once("SIGINT", () => {
    if (instance) instance.unmount();
    if (exitResolve) {
      const r = exitResolve;
      exitResolve = null;
      r();
    }
  });

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
function setupNotificationBridge(args: {
  db: ReturnType<typeof getDb>;
  secretStore: SecretStore;
  notifyConfigPath: string;
}): NotificationBridge | null {
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
  const bridge = new NotificationBridge(service, { bus });
  void bridge.start().catch(() => {
    /* best-effort */
  });
  return bridge;
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
  const db = getDb();
  const registry = new RegistryService(db, bus);
  const secretStore = new SecretStore(db, loadOrCreateSecretsMasterKey());
  const instance = render(
    React.createElement(SetupWizard, {
      initialState: loadSetupState() ?? freshState(),
      services: {
        db,
        secretStore,
        registry,
        policyPath: paths.policyPath,
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
