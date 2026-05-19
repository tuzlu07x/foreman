import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { ulid } from "ulid";

// =============================================================================
// Foreman → Agent directive delivery (#433)
// =============================================================================
//
// `/foreman write <agent> "<msg>"` is the orchestrator-intervention
// path. v0.1 ships a **hybrid** delivery strategy because no agent
// today exposes a true cross-process write API:
//
//   1. **Telegram visible post** (always): Foreman uses the primary
//      chat-capable agent's bot token to post a formatted directive
//      into the user's chat. Agents don't see it (their getUpdates
//      filters their own bot's posts) — this is for the **human** to
//      read + manually forward.
//
//   2. **Inbound dir file write** (opt-in, per-agent): when the
//      target agent declares `inbound_dir` in its registry entry,
//      Foreman also drops a `<inbound_dir>/<ulid>.txt` file. Agents
//      that watch this dir act on it automatically; agents that
//      don't (Hermes / OpenClaw today) leave it as dead-data. This
//      is the upgrade path for v0.2 wrap-mode + future agents.
//
// True end-to-end automation (Foreman invokes agent without user
// relay) lives in the wrap-mode follow-up issue. Out of scope here.

export interface DeliverDirectiveInput {
  agentId: string;
  message: string;
  sourceUser?: string | undefined;
  /** Optional `inbound_dir` from the registry entry. When set, the
   *  file-write path also fires. `~` is expanded to the user's home. */
  inboundDir?: string;
}

export interface DeliveryDeps {
  /** Telegram bot token (typically `telegram-bot-token` from the
   *  secret store — owned by the primary chat agent per #426). When
   *  absent, the Telegram leg is skipped + a "no telegram" reason is
   *  recorded in the outcome. */
  telegramBotToken?: string;
  /** Owner's Telegram chat id (typically `telegram-chat-id`). Same
   *  absence semantics as the bot token. */
  telegramChatId?: string;
  /** Override fetch for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Override the working home dir for `~` expansion (tests). */
  homeDir?: string;
}

export type DirectiveDelivery =
  | "telegram"
  | "file";

export type DirectiveOutcome =
  | { status: "delivered"; via: DirectiveDelivery[]; messageId?: string }
  | { status: "partial"; via: DirectiveDelivery[]; warnings: string[] }
  | { status: "failed"; error: string };

const TELEGRAM_API = "https://api.telegram.org";

export async function deliverWriteDirective(
  input: DeliverDirectiveInput,
  deps: DeliveryDeps = {},
): Promise<DirectiveOutcome> {
  const delivered: DirectiveDelivery[] = [];
  const warnings: string[] = [];

  // Leg 1 — Telegram visible post. Best-effort: a failure here is
  // recorded as a warning but doesn't fail the directive overall if
  // the file write succeeded.
  const telegramOutcome = await sendTelegramDirective(input, deps);
  if (telegramOutcome.status === "ok") {
    delivered.push("telegram");
  } else if (telegramOutcome.status === "skipped") {
    warnings.push(`telegram skipped: ${telegramOutcome.reason}`);
  } else {
    warnings.push(`telegram failed: ${telegramOutcome.reason}`);
  }

  // Leg 2 — File write if the target agent declares an inbound_dir.
  // No retry, no validation that the agent will actually read it —
  // that's the agent's responsibility per the documented contract.
  if (input.inboundDir) {
    const fileOutcome = writeInboundFile(input, deps);
    if (fileOutcome.status === "ok") {
      delivered.push("file");
    } else {
      warnings.push(`file write failed: ${fileOutcome.reason}`);
    }
  }

  if (delivered.length === 0) {
    return {
      status: "failed",
      error:
        warnings.length > 0
          ? warnings.join("; ")
          : "no delivery method succeeded",
    };
  }
  if (warnings.length > 0) {
    return { status: "partial", via: delivered, warnings };
  }
  const messageId =
    telegramOutcome.status === "ok" ? telegramOutcome.messageId : undefined;
  return messageId !== undefined
    ? { status: "delivered", via: delivered, messageId }
    : { status: "delivered", via: delivered };
}

async function sendTelegramDirective(
  input: DeliverDirectiveInput,
  deps: DeliveryDeps,
): Promise<
  | { status: "ok"; messageId: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string }
> {
  if (!deps.telegramBotToken) {
    return { status: "skipped", reason: "no telegram-bot-token configured" };
  }
  if (!deps.telegramChatId) {
    return { status: "skipped", reason: "no telegram-chat-id configured" };
  }
  const text = renderDirectiveText(input);
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
      return {
        status: "failed",
        reason: `HTTP ${res.status}: ${detail}`,
      };
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

function writeInboundFile(
  input: DeliverDirectiveInput,
  deps: DeliveryDeps,
): { status: "ok"; path: string } | { status: "failed"; reason: string } {
  if (!input.inboundDir) {
    return { status: "failed", reason: "no inbound_dir set" };
  }
  const dir = expandHome(input.inboundDir, deps.homeDir ?? homedir());
  const path = resolve(dir, `${ulid()}.txt`);
  const payload = renderInboundFilePayload(input);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, payload, "utf-8");
    if (process.platform !== "win32") chmodSync(path, 0o600);
    return { status: "ok", path };
  } catch (err) {
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// Markdown-escaped, structured so the user sees Foreman as the source
// + the agent as the addressee at a glance. The "forward this message"
// hint primes the manual-relay UX described in #433's hybrid plan.
function renderDirectiveText(input: DeliverDirectiveInput): string {
  const head = `📌 *Foreman → ${escapeMd(input.agentId)}*`;
  const body = escapeMd(input.message);
  const footer = escapeMd(
    "_(Forward this message as your next reply to deliver it.)_",
  );
  return `${head}\n\n${body}\n\n${footer}`;
}

// Structured plain text for agents that watch inbound_dir. Keeps a
// metadata header so the agent can attribute the directive to Foreman
// + the originating user.
function renderInboundFilePayload(input: DeliverDirectiveInput): string {
  const lines = [
    "# Foreman directive",
    `agent: ${input.agentId}`,
    `from_user: ${input.sourceUser ?? "(unknown)"}`,
    `received_at: ${new Date().toISOString()}`,
    "",
    input.message,
    "",
  ];
  return lines.join("\n");
}

function expandHome(p: string, home: string): string {
  if (p.startsWith("~/")) return resolve(home, p.slice(2));
  if (p === "~") return home;
  return p;
}

const MD_ESCAPE = /[_*[\]()~`>#+\-=|{}.!\\]/g;

function escapeMd(s: string): string {
  return s.replace(MD_ESCAPE, "\\$&");
}
