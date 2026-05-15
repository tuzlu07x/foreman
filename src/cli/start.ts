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
  loadSetupState,
} from "../tui/setup-state.js";
import { SetupWizard } from "../tui/setup-wizard.js";
import { SecretStore } from "../core/secret-store.js";
import { loadOrCreateSecretsMasterKey } from "../identity/master-key.js";
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
  const withTui = options.withTui ?? true;
  const approval: ApprovalService = withTui
    ? new BusApprovalService({ bus })
    : new ReadlineApprovalService({ bus });
  const policy = new PolicyEngine(db, bus);
  if (existsSync(paths.policyPath)) policy.loadFromYaml(paths.policyPath);
  const risk = new RiskScorer(db);
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

async function runOnboardingWizard(): Promise<void> {
  const paths = getForemanPaths();
  if (!existsSync(paths.root) || !existsSync(paths.identityPath)) {
    console.log(
      `${orange(bold("Foreman"))} ${dim("— first run, seeding home…")}`,
    );
    runInit({});
    console.log(`${green("✓")} initialised at ${paths.root}\n`);
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

export const startCommand = new Command("start")
  .description("Start the Foreman gateway with the Ink TUI")
  .option(
    "--no-onboarding",
    "skip the auto setup wizard even when the foreman home is fresh",
  )
  .action(async (options: { onboarding?: boolean }) => {
    if (options.onboarding !== false && looksLikeFreshInstall()) {
      await runOnboardingWizard();
    }
    let started: StartedForeman;
    try {
      started = startForeman();
    } catch (err) {
      if (err instanceof NotInitialisedError) {
        console.error(
          red("error: ") +
            `${err.message} Tip: run 'foreman start' and the onboarding wizard will guide you, or 'foreman init' for a manual setup.`,
        );
        process.exit(1);
      }
      throw err;
    }
    await started.waitForExit();
    await started.shutdown();
  });
