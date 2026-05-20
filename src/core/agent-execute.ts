import {
  type SpawnAgentTaskOutcome,
  spawnAgentTask,
} from "./agent-spawn.js";
import type { AgentEntry } from "./registry-catalog.js";

// =============================================================================
// Foreman → Agent task execution + output relay (PR D of orchestration epic)
// =============================================================================
//
// When `foreman write <agent> <task>` targets an agent that declares
// `task_command_template`, Foreman spawns it via the spawn engine (PR C),
// captures stdout/stderr, then posts the output back to the user's chat
// via the same Telegram bot the chat-primary agent uses. Sibling to
// `deliverWriteDirective` in agent-write.ts — that one is the queue+relay
// fallback for non-callable agents (Hermes daemon, etc.).
//
// Key UX: the user typed the directive INTO the chat-primary's chat;
// Foreman acknowledged with "Directive queued" via mcp-stdio's tool
// response; the spawn runs in the background; the captured output
// arrives as a fresh Telegram message ~seconds later. The user perceives
// it as "I asked codex to do X, codex did it, here's the result."

export interface ExecuteDirectiveInput {
  agentId: string;
  /** The user-provided task text (already stripped of `/foreman write
   *  <agent>` prefix). Substituted into the agent's
   *  task_command_template as the `{task}` placeholder. */
  message: string;
  /** Messaging-platform user id that initiated the directive. Forwarded
   *  to the output post for audit-trace alignment with the directive. */
  sourceUser?: string | undefined;
  /** Registry entry for the target agent — MUST have
   *  task_command_template; otherwise we return `unsupported` and the
   *  caller falls back to deliverWriteDirective. */
  entry: AgentEntry;
}

export interface ExecuteDeliveryDeps {
  telegramBotToken?: string;
  telegramChatId?: string;
  fetchImpl?: typeof fetch;
  /** Spawn impl injection point for tests (forwarded into
   *  spawnAgentTask). */
  spawnImpl?: Parameters<typeof spawnAgentTask>[0]["spawnImpl"];
  /** Maximum length (chars) of agent output to include verbatim in the
   *  Telegram post. Telegram's text limit is 4096; we leave headroom for
   *  Foreman's wrapper + Markdown escaping. Default 3500. */
  maxOutputLength?: number;
}

export interface ExecuteDirectiveOutcome {
  /** Spawn result — `unsupported` when the entry has no template, all
   *  other kinds come from the spawn engine. */
  spawn: SpawnAgentTaskOutcome;
  /** Telegram relay status for the OUTPUT message (separate from the
   *  earlier directive ack). `null` when no template (no relay
   *  attempted). */
  outputRelay:
    | { status: "ok"; messageId: string }
    | { status: "skipped"; reason: string }
    | { status: "failed"; reason: string }
    | null;
}

const DEFAULT_MAX_OUTPUT = 3500;
const TELEGRAM_API = "https://api.telegram.org";

/**
 * Spawn the target agent with the user's task, capture its output, and
 * post the result back to the chat-primary's Telegram. Idempotent in the
 * sense that re-calling on the same control-command row just spawns
 * again — callers (start.ts drain handler) are responsible for marking
 * the row applied/failed once.
 */
export async function executeWriteDirective(
  input: ExecuteDirectiveInput,
  deps: ExecuteDeliveryDeps = {},
): Promise<ExecuteDirectiveOutcome> {
  if (!input.entry.task_command_template) {
    return {
      spawn: {
        kind: "unsupported",
        reason: `agent "${input.agentId}" has no task_command_template`,
      },
      outputRelay: null,
    };
  }
  const spawn = await spawnAgentTask({
    entry: input.entry,
    task: input.message,
    spawnImpl: deps.spawnImpl,
  });
  const text = renderOutputText(input, spawn, deps.maxOutputLength);
  const outputRelay = await postTelegramOutput(text, deps);
  return { spawn, outputRelay };
}

/**
 * Build the Telegram message body that delivers the spawned agent's
 * output back to the user. Includes a short header showing which
 * agent ran + the spawn outcome (success/timeout/etc), then the
 * captured stdout (truncated if very long), then a stderr block when
 * present. Pure for tests.
 */
export function renderOutputText(
  input: ExecuteDirectiveInput,
  spawn: SpawnAgentTaskOutcome,
  maxLength: number = DEFAULT_MAX_OUTPUT,
): string {
  const agentName = input.entry.name || input.agentId;
  const header = `📨 *${escapeMd(agentName)}* finished your task`;
  let body: string;
  let tail = "";
  switch (spawn.kind) {
    case "ok": {
      body = truncateForTelegram(spawn.stdout || "(no output)", maxLength);
      if (spawn.stderr.trim()) {
        tail = `\n\n_stderr:_\n\`\`\`\n${truncateForTelegram(spawn.stderr, 800)}\n\`\`\``;
      }
      break;
    }
    case "failed": {
      body =
        `⚠ Exit code: ${spawn.exitCode}\n\n` +
        (spawn.stderr.trim()
          ? `_stderr:_\n\`\`\`\n${truncateForTelegram(spawn.stderr, 1500)}\n\`\`\``
          : "(no stderr)");
      if (spawn.stdout.trim()) {
        tail = `\n\n_stdout:_\n\`\`\`\n${truncateForTelegram(spawn.stdout, 1500)}\n\`\`\``;
      }
      break;
    }
    case "timeout": {
      body =
        `⏱ Timed out after ${(spawn.timeoutMs / 1000).toFixed(0)}s.\n\n` +
        (spawn.stdout.trim() || spawn.stderr.trim()
          ? `_partial output:_\n\`\`\`\n${truncateForTelegram(
              spawn.stdout || spawn.stderr,
              1500,
            )}\n\`\`\``
          : "(no output captured before timeout)");
      break;
    }
    case "unsupported":
      body = `⚠ Cannot spawn ${escapeMd(input.agentId)}: ${escapeMd(spawn.reason)}`;
      break;
    case "spawn-error":
      body = `✗ Spawn error: ${escapeMd(spawn.error)}`;
      break;
  }
  const taskExcerpt = truncateForTelegram(input.message, 200);
  return `${header}\n\n_Task:_ ${escapeMd(taskExcerpt)}\n\n${body}${tail}`;
}

function truncateForTelegram(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n…(${s.length - max} more chars truncated)`;
}

async function postTelegramOutput(
  text: string,
  deps: ExecuteDeliveryDeps,
): Promise<NonNullable<ExecuteDirectiveOutcome["outputRelay"]>> {
  if (!deps.telegramBotToken) {
    return { status: "skipped", reason: "no telegram-bot-token configured" };
  }
  if (!deps.telegramChatId) {
    return { status: "skipped", reason: "no telegram-chat-id configured" };
  }
  const url = `${TELEGRAM_API}/bot${deps.telegramBotToken}/sendMessage`;
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: deps.telegramChatId,
        text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "<no body>");
      return { status: "failed", reason: `HTTP ${res.status}: ${detail}` };
    }
    const body = (await res.json()) as {
      ok?: boolean;
      result?: { message_id?: number };
      description?: string;
    };
    if (!body.ok || !body.result?.message_id) {
      return {
        status: "failed",
        reason: body.description ?? "Telegram sendMessage returned !ok",
      };
    }
    return { status: "ok", messageId: String(body.result.message_id) };
  } catch (err) {
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// MarkdownV2 reserved chars per Telegram docs.
const MD_ESCAPE = /[_*[\]()~`>#+\-=|{}.!\\]/g;
function escapeMd(s: string): string {
  return s.replace(MD_ESCAPE, "\\$&");
}
