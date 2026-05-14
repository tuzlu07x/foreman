import { existsSync } from "node:fs";
import { Command } from "commander";
import { render } from "ink";
import React from "react";
import { bus } from "../core/event-bus.js";
import { RegistryService } from "../core/registry.js";
import { SecretStore } from "../core/secret-store.js";
import { closeDb, getDb } from "../db/client.js";
import { loadOrCreateSecretsMasterKey } from "../identity/master-key.js";
import { launchEditor } from "../tui/launch-editor.js";
import {
  freshState,
  loadSetupState,
  resetSetupState,
} from "../tui/setup-state.js";
import { SetupWizard } from "../tui/setup-wizard.js";
import { getForemanPaths } from "../utils/config.js";
import { red } from "./colors.js";

interface SetupOptions {
  resume?: boolean;
  reset?: boolean;
}

export const setupCommand = new Command("setup")
  .description(
    "Unified onboarding wizard — API keys, agents, MCP config, and policy in one pass",
  )
  .option("--resume", "pick up from the last completed step")
  .option("--reset", "clear setup-state and start over")
  .action(async (options: SetupOptions) => {
    const paths = getForemanPaths();
    if (!existsSync(paths.root) || !existsSync(paths.identityPath)) {
      console.error(
        red("error: ") +
          `Foreman is not initialised. Run 'foreman init' first.`,
      );
      process.exit(1);
    }
    if (options.reset) {
      resetSetupState();
    }
    const initialState = options.resume ? loadSetupState() : freshState();
    const db = getDb();
    const registry = new RegistryService(db, bus);
    const secretStore = new SecretStore(db, loadOrCreateSecretsMasterKey());

    const instance = render(
      React.createElement(SetupWizard, {
        initialState,
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

    const shutdown = (): void => {
      instance.unmount();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    await instance.waitUntilExit();
    closeDb();
  });
