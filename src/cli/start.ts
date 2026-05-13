import { existsSync } from "node:fs";
import { Command } from "commander";
import { render, type Instance } from "ink";
import React from "react";
import {
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
import { closeDb, getDb, getSqlite } from "../db/client.js";
import { loadOrCreateMasterKey } from "../identity/keypair.js";
import { App } from "../tui/app.js";
import type { BootInfo } from "../tui/boot-info.js";
import { getForemanPaths } from "../utils/config.js";
import { red } from "./colors.js";

const APP_VERSION = "0.1.0-pre";

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

export const startCommand = new Command("start")
  .description("Start the Foreman gateway with the Ink TUI")
  .action(async () => {
    let started: StartedForeman;
    try {
      started = startForeman();
    } catch (err) {
      if (err instanceof NotInitialisedError) {
        console.error(red("error: ") + err.message);
        process.exit(1);
      }
      throw err;
    }
    await started.waitForExit();
    await started.shutdown();
  });
