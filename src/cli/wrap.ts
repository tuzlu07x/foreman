import { existsSync } from "node:fs";
import { Command } from "commander";
import { DbApprovalService } from "../core/approval.js";
import { AuditLogger } from "../core/audit.js";
import { bus } from "../core/event-bus.js";
import { deriveApprovalKey } from "../core/approval-token.js";
import { createMediatorStack } from "../core/mediator-stack.js";
import { SecretStore } from "../core/secret-store.js";
import { runWrap } from "../core/wrap-runner.js";
import { closeDb, getDb } from "../db/client.js";
import { loadOrCreateSecretsMasterKey } from "../identity/master-key.js";
import { StdioTransport } from "../mcp/stdio-transport.js";
import { getForemanPaths } from "../utils/config.js";
import { red } from "./colors.js";

interface WrapOptions {
  name: string;
  policy?: string;
  restart?: "never" | "on-failure";
}

export const wrapCommand = new Command("wrap")
  .description(
    "Launch a child process under Foreman; intercept its MCP-framed stdout, sign responses, audit every call",
  )
  .requiredOption("--name <agentId>", "agent id Foreman records on every call")
  .option(
    "--policy <path>",
    "load this policy.yaml instead of the active one (see 'foreman doctor' for its path)",
  )
  .option(
    "--restart <mode>",
    "child restart policy ('never' or 'on-failure')",
    "never",
  )
  .allowUnknownOption(false)
  .argument(
    "<command...>",
    "the child command and its arguments (separate with --)",
  )
  .action(async (commandParts: string[], options: WrapOptions) => {
    if (options.restart !== "never" && options.restart !== "on-failure") {
      console.error(
        red("error: ") + `--restart must be 'never' or 'on-failure'`,
      );
      process.exit(1);
    }
    const paths = getForemanPaths();
    if (!existsSync(paths.root)) {
      console.error(
        red("error: ") + `Foreman is not initialised. Run 'foreman init' first.`,
      );
      process.exit(1);
    }
    if (commandParts.length === 0) {
      console.error(
        red("error: ") +
          "no command supplied. Usage: foreman wrap --name <id> -- <cmd> <args...>",
      );
      process.exit(1);
    }

    const [command, ...args] = commandParts;
    if (!command) {
      console.error(red("error: ") + "empty child command");
      process.exit(1);
    }

    const db = getDb();
    const audit = new AuditLogger(db, bus);
    const masterKey = loadOrCreateSecretsMasterKey();
    // Cross-process IPC via SQLite — TUI in `foreman start` bridges this.
    // FOREMAN_APPROVAL_TIMEOUT wins over the 60 s interactive default.
    const approval = new DbApprovalService(db, {
      bus,
      ...(process.env.FOREMAN_APPROVAL_TIMEOUT ? {} : { timeoutMs: 60_000 }),
      approvalKey: deriveApprovalKey(masterKey),
    });
    const { registry, mediator } = createMediatorStack({
      db,
      bus,
      approval,
      policyPath: options.policy ?? paths.policyPath,
      onPolicyError: (message) => process.stderr.write(`foreman wrap: ${message}\n`),
      secretStore: new SecretStore(db, masterKey),
    });

    const session = runWrap({
      agentId: options.name,
      displayName: options.name,
      command,
      args,
      restart: options.restart,
      registry,
      mediator,
      transportFactory: (opts) =>
        new StdioTransport({
          command: opts.command,
          args: opts.args,
          env: opts.env,
          cwd: opts.cwd,
          onMessage: opts.onMessage,
          onExit: opts.onExit,
          onError: opts.onError,
        }),
    });

    const shutdown = (signal: NodeJS.Signals): void => {
      console.error(`\n(wrap) received ${signal} — stopping child`);
      session.stop();
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));

    const exitCode = await session.done;
    audit.dispose();
    closeDb();
    process.exit(exitCode ?? 0);
  });
