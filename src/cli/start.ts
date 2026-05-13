import { existsSync } from "node:fs";
import { Command } from "commander";
import { render, type Instance } from "ink";
import React from "react";
import {
  ReadlineApprovalService,
  type ApprovalService,
} from "../core/approval.js";
import { AuditLogger } from "../core/audit.js";
import { bus } from "../core/event-bus.js";
import { RegistryService } from "../core/registry.js";
import { closeDb, getDb } from "../db/client.js";
import { loadOrCreateMasterKey } from "../identity/keypair.js";
import { App } from "../tui/app.js";
import { getForemanPaths } from "../utils/config.js";
import { red } from "./colors.js";

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
  publicKey: Buffer;
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
  const registry = new RegistryService(db, bus);
  const audit = new AuditLogger(db, bus);
  const approval = new ReadlineApprovalService({ bus });

  const withTui = options.withTui ?? true;
  let instance: Instance | null = null;
  let exitResolve: (() => void) | null = null;
  let keepAlive: NodeJS.Timeout | null = null;

  if (withTui) {
    instance = render(React.createElement(App), {
      exitOnCtrlC: false,
    });
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

  if (!withTui) {
    process.once("SIGINT", () => {
      if (exitResolve) {
        const r = exitResolve;
        exitResolve = null;
        r();
      }
    });
  }

  return { registry, audit, approval, publicKey, waitForExit, shutdown };
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
