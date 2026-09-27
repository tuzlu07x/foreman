import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError, Option } from "commander";
import { parseDocument } from "yaml";
import { findOrgTemplate } from "../../core/org/templates.js";
import { saveOrgText } from "../../core/org/org.js";
import { RegistryService } from "../../core/registry.js";
import { AGENT_TOKEN_ENV, ensureAgentToken } from "../../core/agent-token.js";
import { SecretStore } from "../../core/secret-store.js";
import { loadOrCreateSecretsMasterKey } from "../../identity/master-key.js";
import { EventBus, type ForemanEventMap } from "../../core/event-bus.js";
import { USAGE_KEY_HEADER } from "../../core/usage/otlp-receiver.js";
import { closeDb, getDb } from "../../db/client.js";
import { getForemanPaths } from "../../utils/config.js";
import { bold, dim, green, orange, red } from "../colors.js";
import { DEMO_SCRIPT, playDemo, type DemoActions } from "./script.js";
import { needsEnvNode, writeDemoStubs } from "./stubs.js";

// =============================================================================
// foreman demo — a live company of agents in a sandbox (#632)
// =============================================================================
//
// Everything happens in a throwaway directory:
//   <tmp>/foreman-demo-XXXX/home   FOREMAN_HOME (never your ~/.foreman)
//   <tmp>/foreman-demo-XXXX/bin    stand-in agent CLIs, first on PATH
//   <tmp>/foreman-demo-XXXX/work   the "project" the agents work in
// The real TUI opens on that home while a scripted day plays out through
// the real gateway, org chart and telemetry endpoint. Nothing reaches your
// real agents, files or accounts. The directory is removed on exit unless
// --keep.

export const DEMO_AGENTS: Array<{ id: string; displayName: string; modelVersion?: string }> = [
  { id: "hermes", displayName: "Hermes" },
  { id: "claude-code", displayName: "Claude Code" },
  // Codex prints only a token total, so the model prices it.
  { id: "codex", displayName: "Codex", modelVersion: "gpt-5" },
  { id: "openclaw", displayName: "OpenClaw" },
  { id: "zeroclaw", displayName: "ZeroClaw" },
  { id: "generic-mcp", displayName: "Support bot" },
];

export interface DemoLayout {
  root: string;
  home: string;
  bin: string;
  work: string;
}

export function createDemoLayout(parent: string = tmpdir()): DemoLayout {
  const root = mkdtempSync(join(parent, "foreman-demo-"));
  const layout = { root, home: join(root, "home"), bin: join(root, "bin"), work: join(root, "work") };
  for (const dir of [layout.home, layout.bin, layout.work]) mkdirSync(dir, { recursive: true });
  writeDemoStubs(layout.bin);
  // A decoy secret for the agents to reach for.
  writeFileSync(join(layout.work, ".env"), "STRIPE_SECRET_KEY=sk_demo_not_a_real_key\n", { mode: 0o600 });
  writeFileSync(join(layout.work, "README.md"), "# demo-api\nThe project the demo agents work on.\n");
  return layout;
}

/** Directories a demo process may find programs in: the stand-in agents,
 *  then system tools only. Your own PATH is left out on purpose, so an agent
 *  CLI the demo doesn't stand in for can't resolve to the real one. */
export function demoPath(layout: DemoLayout, nodePath: string = process.execPath): string {
  const dirs = [layout.bin, "/usr/bin", "/bin"];
  // Only when the stand-ins had to use `env node` (see stubs.ts).
  if (needsEnvNode(nodePath)) dirs.push(dirname(nodePath));
  return dirs.join(delimiter);
}

/** The environment every demo process runs with: the demo home, the stub
 *  agents on a PATH of their own, and no update checks. Exported for tests. */
export function demoEnv(layout: DemoLayout, base: NodeJS.ProcessEnv, otlpPort: number): NodeJS.ProcessEnv {
  return {
    ...base,
    FOREMAN_HOME: layout.home,
    PATH: demoPath(layout),
    FOREMAN_NO_UPDATE_CHECK: "1",
    FOREMAN_OTLP_PORT: String(otlpPort),
    FOREMAN_APPROVAL_TIMEOUT: base.FOREMAN_DEMO_APPROVAL_TIMEOUT ?? "180",
    FOREMAN_DEMO: "1",
  };
}

/** How to run this CLI again: this node and the script it is running. An
 *  npm install runs us through a `foreman` symlink, so resolve it. */
function self(): { command: string; prefix: string[] } {
  const script = process.argv[1];
  return { command: process.execPath, prefix: [script ? realpathSync(script) : fileURLToPath(import.meta.url)] };
}

/** Seed the demo home in this process (runs with FOREMAN_HOME set). */
export function seedDemoHome(): void {
  const paths = getForemanPaths();
  const template = findOrgTemplate("startup");
  if (!template) throw new Error("startup org template missing");
  const org = parseDocument(template.render("Demo Robotics"));
  // A small daily budget so the demo can show an alert.
  org.setIn(["departments", "marketing", "budget"], { daily_usd: 1, on_exceed: "pause" });
  saveOrgText(paths.orgConfigPath, org.toString());
  const registry = new RegistryService(getDb(), new EventBus<ForemanEventMap>());
  const store = new SecretStore(getDb(), loadOrCreateSecretsMasterKey());
  const tokens: Record<string, string> = {};
  for (const a of DEMO_AGENTS) {
    if (!registry.get(a.id)) {
      registry.register({ id: a.id, displayName: a.displayName, transport: "stdio", ...(a.modelVersion ? { modelVersion: a.modelVersion } : {}) });
    }
    tokens[a.id] = ensureAgentToken(store, a.id);
  }
  // The stand-ins prove who they are like real agents do (#618). Their
  // tokens live only in the throwaway demo home.
  writeFileSync(demoTokensPath(paths.root), JSON.stringify(tokens), { mode: 0o600 });
  closeDb();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export function demoTokensPath(home: string): string {
  return join(home, "demo-agent-tokens.json");
}

function demoTokens(home: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(demoTokensPath(home), "utf-8")) as Record<string, string>;
  } catch {
    return {}; // the calls then run untrusted, which the demo survives
  }
}

/** The real actions, as separate processes against the demo home. */
export function demoActions(layout: DemoLayout, env: NodeJS.ProcessEnv, children: Set<ChildProcess>): DemoActions {
  const me = self();
  const tokens = demoTokens(layout.home);
  const mcpCall = (agent: string, tool: string, args: Record<string, unknown>): Promise<void> =>
    new Promise((resolve) => {
      const token = tokens[agent];
      const child = spawn(me.command, [...me.prefix, "mcp-stdio", "--source", agent], {
        env: token ? { ...env, [AGENT_TOKEN_ENV]: token } : env,
        cwd: layout.work,
        stdio: ["pipe", "pipe", "ignore"],
      });
      children.add(child);
      let buf = "";
      const done = (): void => {
        children.delete(child);
        child.stdin?.end();
        resolve();
      };
      child.stdout?.on("data", (d: Buffer) => {
        buf += d.toString();
        if (buf.includes('"id":2')) done();
      });
      child.on("exit", done);
      const send = (m: unknown): void => {
        child.stdin?.write(`${JSON.stringify(m)}\n`);
      };
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "foreman-demo", version: "1" } } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
    });
  return {
    post: (agent, to, text, kind) => mcpCall(agent, "org_post", { to, text, ...(kind ? { kind } : {}) }),
    report: (agent, text) => mcpCall(agent, "org_report", { text }),
    toolCall: (agent, tool, args) => mcpCall(agent, tool, args),
    delegate: (from, to, task) =>
      new Promise((resolve) => {
        const child = spawn(me.command, [...me.prefix, "write", to, task], {
          env: { ...env, FOREMAN_SPAWNED_BY: from },
          cwd: layout.work,
          stdio: "ignore",
        });
        children.add(child);
        child.on("exit", () => {
          children.delete(child);
          resolve();
        });
      }),
    usage: async (agent, model, input, output, costUsd) => {
      const keyPath = join(layout.home, "usage.key");
      if (!existsSync(keyPath)) return;
      const key = readFileSync(keyPath, "utf-8").trim();
      const attr = (k: string, v: number) => ({
        key: k,
        value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v },
      });
      await fetch(`http://127.0.0.1:${env.FOREMAN_OTLP_PORT}/v1/logs`, {
        method: "POST",
        headers: { "content-type": "application/json", [USAGE_KEY_HEADER]: key },
        body: JSON.stringify({
          resourceLogs: [
            {
              resource: { attributes: [{ key: "foreman.agent", value: { stringValue: agent } }] },
              scopeLogs: [
                {
                  logRecords: [
                    {
                      body: { stringValue: "claude_code.api_request" },
                      attributes: [
                        { key: "model", value: { stringValue: model } },
                        attr("input_tokens", input),
                        attr("output_tokens", output),
                        attr("cost_usd", costUsd),
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      }).catch(() => undefined);
    },
  };
}

function parseSpeed(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 100) throw new InvalidArgumentError("use a number from 0.1 to 100");
  return n;
}

export const demoCommand = new Command("demo")
  .description("Watch a company of agents at work in a sandbox: no keys, no setup, nothing touched")
  .option("--keep", "keep the demo directory afterwards")
  .option("--speed <n>", "play the scripted day faster (2 = twice as fast)", parseSpeed, 1)
  .addOption(new Option("--internal-seed").hideHelp())
  .action(async (opts: { keep?: boolean; speed: number; internalSeed?: boolean }) => {
    if (opts.internalSeed) {
      seedDemoHome();
      return;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error(`${red("error:")} foreman demo opens the TUI, so it needs an interactive terminal.`);
      process.exit(1);
    }
    const layout = createDemoLayout();
    const env = demoEnv(layout, process.env, await freePort());
    const me = self();
    const run = (args: string[]): void => {
      const out = spawnSync(me.command, [...me.prefix, ...args], { env, cwd: layout.work, encoding: "utf-8" });
      if (out.status !== 0) throw new Error(`foreman ${args.join(" ")} failed: ${out.stderr.trim()}`);
    };
    const cleanup = (): void => {
      if (!opts.keep) rmSync(layout.root, { recursive: true, force: true });
    };
    try {
      run(["init"]);
      run(["demo", "--internal-seed"]);
    } catch (err) {
      cleanup();
      console.error(`${red("error:")} ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    console.log("");
    console.log(`${orange(bold("🦫 Foreman demo"))} — Demo Robotics, a company of agents, in a sandbox`);
    console.log(dim("   CEO hermes · CTO claude-code · Engineer codex · CMO openclaw · CFO zeroclaw"));
    console.log(dim("   The agents are stand-ins: canned answers, no network, nothing outside the demo folder."));
    console.log("");
    console.log(`   Watch the day unfold (${DEMO_SCRIPT.length} events over ~${Math.ceil(DEMO_SCRIPT.at(-1)!.at / 1000 / opts.speed)} s), then try:`);
    console.log(`     ${bold("a")} / ${bold("d")}   answer an approval when it pops up`);
    console.log(`     ${bold(":")}       the console → ${bold("report engineering")} · ${bold("spend")} · ${bold("comms")} · ${bold("tell marketing ship it Friday")}`);
    console.log(`     ${bold("n")}       your inbox          ${bold("q")}  quit`);
    console.log("");
    await new Promise((r) => setTimeout(r, 2_500));

    const children = new Set<ChildProcess>();
    const abort = new AbortController();
    const tui = spawn(me.command, [...me.prefix, "start", "--skip-setup"], { env, cwd: layout.work, stdio: "inherit" });
    // Stay up until the TUI has exited, so the demo folder is always
    // removed: pass a stop on to it (Ctrl-C already reaches it directly).
    const onSignal = (signal: NodeJS.Signals): void => {
      if (signal !== "SIGINT") tui.kill(signal);
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, onSignal);
    void playDemo(demoActions(layout, env, children), {
      workDir: layout.work,
      speed: opts.speed,
      signal: abort.signal,
    });
    const code: number = await new Promise((resolve) => tui.on("exit", (c) => resolve(c ?? 0)));
    abort.abort();
    for (const child of children) child.kill("SIGTERM");
    cleanup();
    console.log("");
    console.log(
      opts.keep
        ? `${green("✓")} demo kept at ${layout.root} (FOREMAN_HOME=${layout.home})`
        : `${green("✓")} demo cleaned up. Ready for the real thing? ${bold("foreman setup")}`,
    );
    process.exit(code);
  });
