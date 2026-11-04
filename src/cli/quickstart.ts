import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Command } from "commander";
import { foremanCliArgv } from "../core/agent-instance.js";
import { defaultHookCommand, installPreToolUseHook } from "../core/agent-hook.js";
import { resolveAgentSettingsPath } from "../core/agent-permissions.js";
import { probeGateway, gatewayHolder } from "../core/gateway.js";
import { loadLlmConfig, saveLlmConfig } from "../core/llm/config.js";
import { approvalButtonSigner, approvalSigner } from "../core/approval-token.js";
import {
  CHAT_APP_TOKEN,
  explainDeliveryError,
  findTelegramChat,
  saveChatApp,
  sendChatAppTest,
  type TelegramChat,
  type TestResult,
} from "../core/notification/chat-app-setup.js";
import { channelConfig, loadNotifyConfig } from "../core/notification/notify-config.js";
import { checkTelegramBot, type TokenCheck } from "../core/notification/token-checks.js";
import { loadActiveRegistry } from "../core/registry-catalog.js";
import { RegistryService } from "../core/registry.js";
import { SecretStore } from "../core/secret-store.js";
import { closeDb, getDb } from "../db/client.js";
import { loadOrCreateSecretsMasterKey } from "../identity/master-key.js";
import { getForemanPaths } from "../utils/config.js";
import { runAgentAddScripted } from "./agent-add.js";
import { bold, dim, green, orange, red } from "./colors.js";
import { runInit } from "./init.js";
import { connectClaudeCode } from "./llm-cli.js";
import { readSecretValueFromStdin } from "./secrets-cli.js";

// =============================================================================
// foreman quickstart: Claude Code and Telegram, then your first approval card
// =============================================================================
//
// One straight path for someone who just installed Foreman: no menus, no
// choices beyond yes and no, and it ends with a real card on their phone. The
// full wizard (`foreman setup`) is still there for everything else.

const MAX_TOKEN_TRIES = 3;
const CHAT_POLL_MS = 3000;
const CHAT_POLL_TRIES = 60;
/** Long enough to find your phone; the card is denied after this. */
const FIRST_APPROVAL_SECONDS = 300;

export type FirstApproval = "allowed" | "denied" | "failed";

export interface QuickstartIo {
  say(line: string): void;
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  wait(ms: number): Promise<void>;
}

export interface QuickstartSteps {
  /** Who runs Foreman right now, or null. */
  gatewayRunning(): string | null;
  connectClaude(): Promise<void>;
  /** Register Claude Code; with `wire`, also add Foreman to its settings. */
  guardClaude(wire: boolean): Promise<void>;
  telegramReady(): boolean;
  checkBot(token: string): Promise<TokenCheck<{ username: string | null }>>;
  findChat(token: string): Promise<TokenCheck<TelegramChat | null>>;
  saveTelegram(token: string, chatId: string): Promise<TestResult>;
  firstApproval(): Promise<FirstApproval>;
}

function saidYes(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === "" || a === "y" || a === "yes" || a === "e" || a === "evet";
}

async function connectTelegram(io: QuickstartIo, steps: QuickstartSteps): Promise<boolean> {
  io.say("  1. Open Telegram and message @BotFather: https://t.me/BotFather");
  io.say("  2. Send /newbot, pick a name and a username ending in 'bot'");
  io.say("  3. Copy the token BotFather sends");
  let token = "";
  let bot: string | null = null;
  for (let tries = 0; ; tries++) {
    token = (await io.askSecret("  Paste the bot token (hidden): ")).trim();
    const check = await steps.checkBot(token);
    if (check.status === "ok") {
      bot = check.value.username;
      break;
    }
    const why =
      check.status === "unreachable"
        ? "Foreman can't reach Telegram. Check your connection."
        : "Telegram rejected that token. Copy it again from @BotFather.";
    io.say(`  ${orange("!")} ${why}`);
    if (tries + 1 >= MAX_TOKEN_TRIES) return false;
  }
  io.say(`  ${green("✓")} Bot ${bold(bot ? `@${bot}` : "found")}`);
  io.say(`  4. Open your bot in Telegram, press Start and send it any message${bot ? `: https://t.me/${bot}` : ""}`);
  io.say("  Waiting for your message…");
  for (let i = 0; i < CHAT_POLL_TRIES; i++) {
    const found = await steps.findChat(token);
    if (found.status === "rejected") {
      io.say(`  ${orange("!")} Telegram stopped accepting that token. Run this again with a new one.`);
      return false;
    }
    if (found.status === "ok" && found.value) {
      const chat = found.value;
      if (!saidYes(await io.ask(`  Found ${bold(chat.name)}. Approvals go to this chat. Is this you? (Y/n) `))) {
        io.say("  Send your bot a message from your own account, then press Enter here.");
        await io.ask("");
        continue;
      }
      const test = await steps.saveTelegram(token, chat.chatId);
      if (!test.ok) {
        io.say(`  ${orange("!")} ${test.reason}`);
        return false;
      }
      io.say(`  ${green("✓")} Telegram connected. A test message is on your phone.`);
      return true;
    }
    await io.wait(CHAT_POLL_MS);
  }
  io.say(`  ${orange("!")} No message arrived. Send your bot a message and run this again.`);
  return false;
}

/** The whole path. Returns the exit code. */
export async function runQuickstart(
  io: QuickstartIo,
  steps: QuickstartSteps,
  now: () => number = Date.now,
): Promise<number> {
  const started = now();
  const running = steps.gatewayRunning();
  if (running) {
    io.say(`${orange("!")} Foreman is already running: ${running}. Quit it, then run this again.`);
    return 1;
  }
  io.say(bold("Foreman quick start"));
  io.say(dim("Claude Code and Telegram, then your first approval card. About 5 minutes.\n"));

  io.say(bold("1/3 Claude Code"));
  try {
    await steps.connectClaude();
  } catch (err) {
    io.say(`  ${red("✗")} ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  io.say(`  ${green("✓")} Connected. Foreman uses your own Claude Code and holds no Claude login.`);
  const wire = saidYes(
    await io.ask("  Guard Claude Code? Foreman adds its hook and MCP server to Claude Code's settings. (Y/n) "),
  );
  try {
    await steps.guardClaude(wire);
  } catch (err) {
    io.say(`  ${red("✗")} ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  io.say(
    wire
      ? `  ${green("✓")} Claude Code now asks Foreman before it acts.`
      : dim("  Skipped. When you're ready: foreman agent rewire claude-code, then foreman agent hook install claude-code"),
  );

  io.say(bold("\n2/3 Telegram"));
  if (steps.telegramReady()) {
    io.say(`  ${green("✓")} Already connected.`);
  } else if (!(await connectTelegram(io, steps))) {
    return 1;
  }

  io.say(bold("\n3/3 Your first approval"));
  io.say("  Foreman will now play an agent reaching for a .env file. Nothing is read.");
  io.say(`  A card is on its way to your phone. Tap ${bold("Deny")}.`);
  const decision = await steps.firstApproval();
  if (decision === "failed") {
    io.say(`  ${orange("!")} The card didn't come back. Run foreman doctor, then this again.`);
    return 1;
  }
  io.say(
    decision === "denied"
      ? `  ${green("✓")} Blocked. An agent gets the same answer when it reaches for a secret.`
      : `  ${green("✓")} Allowed. Tap Deny next time and the agent is stopped.`,
  );

  const seconds = Math.round((now() - started) / 1000);
  io.say(bold(`\nDone in ${Math.floor(seconds / 60)} min ${seconds % 60} s.`));
  io.say("  foreman start             the live view; keep it running for approvals");
  io.say("  foreman service install   the same with the terminal closed");
  io.say("  In Telegram, ask your bot: report me");
  return 0;
}

/** Play an agent that wants a secret, through the same gateway and hook a
 *  real agent uses. The hook only decides: the file isn't there. */
async function firstApprovalCard(configDir: string): Promise<FirstApproval> {
  const [command, ...cli] = foremanCliArgv();
  if (!command) return "failed";
  const env = { ...process.env, FOREMAN_APPROVAL_TIMEOUT: String(FIRST_APPROVAL_SECONDS) };
  const gateway = spawn(command, [...cli, "daemon", "--service"], { stdio: "ignore", env });
  try {
    for (let i = 0; i < 150 && probeGateway(configDir).state === "none"; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (probeGateway(configDir).state === "none") return "failed";
    // Its channels connect just after it says it's up.
    await new Promise((r) => setTimeout(r, 1500));
    const cwd = tmpdir();
    const hook = spawn(command, [...cli, "hook", "claude-code"], { stdio: ["pipe", "ignore", "ignore"], env, cwd });
    const exit = new Promise<number | null>((resolve) => {
      hook.once("exit", resolve);
      hook.once("error", () => resolve(null));
    });
    hook.stdin.on("error", () => undefined);
    hook.stdin.end(
      JSON.stringify({
        session_id: "foreman-quickstart",
        hook_event_name: "PreToolUse",
        cwd,
        tool_name: "Read",
        tool_input: { file_path: join(cwd, "foreman-quickstart", ".env") },
      }),
    );
    const code = await exit;
    return code === 0 ? "allowed" : code === 2 ? "denied" : "failed";
  } finally {
    const stopped = new Promise((resolve) => gateway.once("exit", resolve));
    gateway.kill("SIGTERM");
    await Promise.race([stopped, new Promise((r) => setTimeout(r, 5000))]);
  }
}

function terminalIo(): QuickstartIo {
  return {
    say: (line) => console.log(line),
    ask: (question) =>
      new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => {
          rl.close();
          resolve(answer);
        });
      }),
    askSecret: (question) => readSecretValueFromStdin(question),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export const quickstartCommand = new Command("quickstart")
  .description("Connect Claude Code and Telegram and get your first approval card, in about 5 minutes")
  .action(async () => {
    if (!process.stdin.isTTY) {
      console.error(red("error: ") + "quickstart asks you a few things: run it in a terminal.");
      process.exit(1);
    }
    const paths = getForemanPaths();
    if (!existsSync(paths.dbPath)) runInit();
    const db = getDb();
    const masterKey = loadOrCreateSecretsMasterKey();
    const store = new SecretStore(db, masterKey);
    const registry = new RegistryService(db);
    const signers = { signApproval: approvalSigner(masterKey), signButton: approvalButtonSigner(masterKey) };
    const code = await runQuickstart(terminalIo(), {
      gatewayRunning: () => {
        const gateway = probeGateway(paths.configDir);
        return gateway.state === "none" ? null : gatewayHolder(gateway);
      },
      connectClaude: async () => {
        await connectClaudeCode(paths.llmConfigPath);
        const config = loadLlmConfig(paths.llmConfigPath);
        saveLlmConfig(paths.llmConfigPath, {
          ...config,
          enabled: true,
          features: { ...config.features, orchestrator_chat: true },
        });
      },
      guardClaude: async (wire) => {
        if (!registry.get("claude-code")) {
          const added = await runAgentAddScripted(
            "claude-code",
            { type: "claude-code", ...(wire ? {} : { skipConfig: true }) },
            { db, registry, log: () => undefined },
          );
          if (added !== 0) throw new Error("Foreman couldn't add Claude Code. Run: foreman agent add claude-code");
        }
        if (!wire) return;
        const entry = loadActiveRegistry().doc.agents.find((a) => a.id === "claude-code");
        installPreToolUseHook({
          settingsPath: resolveAgentSettingsPath(entry?.config_paths ?? []),
          hookCommand: defaultHookCommand("claude-code"),
        });
      },
      telegramReady: () => {
        if (!existsSync(paths.notifyConfigPath)) return false;
        const toggle = channelConfig(loadNotifyConfig(paths.notifyConfigPath), "telegram");
        return toggle?.enabled === true && Boolean(toggle.chat_id) && store.exists(CHAT_APP_TOKEN.telegram);
      },
      checkBot: (token) => checkTelegramBot(token),
      findChat: (token) => findTelegramChat(token),
      saveTelegram: async (token, chatId) => {
        const toggle = saveChatApp("telegram", { token, chatId }, { store, notifyConfigPath: paths.notifyConfigPath });
        try {
          return await sendChatAppTest("telegram", toggle, { secrets: store, ...signers }, "foreman quickstart");
        } catch (err) {
          return { ok: false, reason: explainDeliveryError("telegram", err instanceof Error ? err.message : String(err)) };
        }
      },
      firstApproval: () => firstApprovalCard(paths.configDir),
    });
    closeDb();
    process.exit(code);
  });
