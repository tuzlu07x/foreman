import { existsSync } from "node:fs";
import { Command } from "commander";
import { render } from "ink";
import React from "react";
import { ChatPrimaryService } from "../core/chat-primary.js";
import { bus } from "../core/event-bus.js";
import {
  loadActiveRegistry,
  RegistryNotFoundError,
  RegistryValidationError,
} from "../core/registry-catalog.js";
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
import { SetupWizard, type WizardOauthRunStep } from "../tui/setup-wizard.js";
import { getForemanPaths } from "../utils/config.js";
import { red } from "./colors.js";
import { runOauthFlows } from "./run-oauth-flow.js";

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
    if (!process.stdin.isTTY) {
      console.error(
        red("error: ") +
          "foreman setup requires an interactive terminal (stdin must be a TTY).",
      );
      console.error(
        "  → Run it directly in a terminal, or use the scripted equivalents:",
      );
      console.error("    foreman secrets add <name>");
      console.error("    foreman agent add <name> --type <id> --auto-install");
      process.exit(1);
    }
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
    // Pre-flight: the wizard's useMemo(loadActiveRegistry) call throws
    // synchronously during React render if the registry file fails to parse
    // — and Ink surfaces that as a bare React stacktrace, which is awful UX
    // for the user's first contact with Foreman (#276). Catch the error
    // here and print a friendly message + remediation hints instead.
    try {
      loadActiveRegistry();
    } catch (err) {
      console.error(red("error: ") + describeRegistryError(err));
      console.error("  → Run `foreman registry validate` to inspect.");
      console.error(
        "  → Run `foreman registry update --force` if the cached copy is stale.",
      );
      console.error("  → Or reinstall: npm install -g foreman-agent@latest");
      process.exit(1);
    }
    const initialState = options.resume ? loadSetupState() : freshState();
    const db = getDb();
    const registry = new RegistryService(db, bus);
    const secretStore = new SecretStore(db, loadOrCreateSecretsMasterKey());
    const chatPrimary = new ChatPrimaryService(db, { bus });

    // #468 — Wizard's [y] hotkey hands its OAuth queue here; we run the
    // commands AFTER Ink unmounts so spawnSync's inherited stdio gets
    // the bare terminal (browser flows + interactive prompts work).
    const oauthQueue: WizardOauthRunStep[] = [];
    const instance = render(
      React.createElement(SetupWizard, {
        initialState,
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
    if (oauthQueue.length > 0) {
      runOauthFlows(oauthQueue);
    }
    closeDb();
  });

// Render a registry-load failure in plain prose, with per-issue lines when
// it's a schema validation error. Used by `foreman setup`'s pre-flight (#276).
function describeRegistryError(err: unknown): string {
  if (err instanceof RegistryValidationError) {
    const head = `${err.message}`;
    if (err.issues.length === 0) return head;
    const lines = err.issues
      .slice(0, 6)
      .map((i) => `\n  - ${i.path || "<root>"}: ${i.message}`)
      .join("");
    const more =
      err.issues.length > 6
        ? `\n  (+ ${err.issues.length - 6} more issues)`
        : "";
    return `${head}${lines}${more}`;
  }
  if (err instanceof RegistryNotFoundError) {
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
