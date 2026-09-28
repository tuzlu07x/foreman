import { slackEndpoints } from "./channels/slack-endpoints.js";

// =============================================================================
// Live token checks for the two-way chat setups (#657)
// =============================================================================
//
// `notify approval-bot`, `slack-interactive` and `discord-interactive` ask
// the platform whether a token works. Offline, a failed request read as
// "Telegram rejected that token", sending the user off to regenerate a
// token that was fine. A request that never got an answer is now told
// apart from a real rejection.

export type TokenCheck<T = null> =
  | { status: "ok"; value: T }
  | { status: "rejected"; detail: string | null }
  | { status: "unreachable"; detail: string };

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

async function ask(url: string, init: RequestInit | undefined, fetchFn: FetchFn): Promise<Response | { unreachable: string }> {
  try {
    return await fetchFn(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) });
  } catch (err) {
    return { unreachable: networkReason(err) };
  }
}

function networkReason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === "TimeoutError" || err.name === "AbortError") return "no answer in 15s";
  const cause = (err as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === "string" ? `${err.message}: ${cause.code}` : err.message;
}

async function jsonOf(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json();
    return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function checkTelegramBot(
  token: string,
  fetchFn: FetchFn = fetch,
): Promise<TokenCheck<{ username: string | null }>> {
  const res = await ask(`https://api.telegram.org/bot${token}/getMe`, undefined, fetchFn);
  if ("unreachable" in res) return { status: "unreachable", detail: res.unreachable };
  const body = await jsonOf(res);
  if (body?.ok !== true) {
    return { status: "rejected", detail: typeof body?.description === "string" ? body.description : null };
  }
  const result = body.result as { username?: unknown } | undefined;
  return { status: "ok", value: { username: typeof result?.username === "string" ? result.username : null } };
}

export async function checkSlackAppToken(token: string, fetchFn: FetchFn = fetch): Promise<TokenCheck> {
  const res = await ask(
    `${slackEndpoints().api}/apps.connections.open`,
    { method: "POST", headers: { authorization: `Bearer ${token}` } },
    fetchFn,
  );
  if ("unreachable" in res) return { status: "unreachable", detail: res.unreachable };
  const body = await jsonOf(res);
  if (body?.ok !== true) {
    return { status: "rejected", detail: typeof body?.error === "string" ? body.error : null };
  }
  return { status: "ok", value: null };
}

export async function checkDiscordBot(token: string, fetchFn: FetchFn = fetch): Promise<TokenCheck> {
  const res = await ask("https://discord.com/api/v10/users/@me", { headers: { authorization: `Bot ${token}` } }, fetchFn);
  if ("unreachable" in res) return { status: "unreachable", detail: res.unreachable };
  if (!res.ok) return { status: "rejected", detail: `HTTP ${res.status}` };
  return { status: "ok", value: null };
}

/** The line to print when a check didn't pass. */
export function describeFailedTokenCheck(
  service: string,
  what: string,
  check: Exclude<TokenCheck<unknown>, { status: "ok" }>,
): string {
  if (check.status === "unreachable") {
    return `couldn't reach ${service} to check the ${what} (${check.detail}). Check the network connection, or re-run with --no-verify to skip this check.`;
  }
  return `${service} rejected the ${what}${check.detail ? ` (${check.detail})` : ""}. Re-run with --no-verify to skip this check.`;
}
