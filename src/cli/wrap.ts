import { existsSync } from "node:fs";
import { Command } from "commander";
import { DbApprovalService } from "../core/approval.js";
import { AuditLogger } from "../core/audit.js";
import { bus } from "../core/event-bus.js";
import { MediatorService } from "../core/mediator.js";
import { PolicyEngine } from "../core/policy-engine.js";
import { RegistryService } from "../core/registry.js";
import { RiskScorer } from "../core/risk-scorer.js";
import { SecretStore } from "../core/secret-store.js";
import { SessionManager } from "../core/session.js";
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
    const registry = new RegistryService(db, bus);
    const audit = new AuditLogger(db, bus);
    // Cross-process IPC via SQLite — TUI in `foreman start` bridges this.
    const approval = new DbApprovalService(db, { bus, timeoutMs: 60_000 });
    const policy = new PolicyEngine(db, bus);
    const policyPath = options.policy ?? paths.policyPath;
    if (existsSync(policyPath)) policy.loadFromYaml(policyPath);
    const risk = new RiskScorer(db);
    const sessionManager = new SessionManager(db, { bus });
    const secretStore = new SecretStore(db, loadOrCreateSecretsMasterKey());
    const mediator = new MediatorService({
      registry,
      policy,
      risk,
      approval,
      sessionManager,
      db,
      bus,
      secretStore,
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
