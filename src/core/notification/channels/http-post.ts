// Shared outbound-HTTP helper for the push-only channels (Slack, Discord,
// ntfy). One place owns the timeout, the error shape and the rule that a
// provider's response body is never echoed verbatim (webhook URLs and
// tokens sometimes appear in provider error pages).

export interface HttpFetch {
  (
    url: string,
    init: RequestInit,
  ): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

export const defaultFetch: HttpFetch = (url, init) => fetch(url, init) as never;

export class ChannelDeliveryError extends Error {
  constructor(
    public readonly channel: string,
    public readonly status: number,
    detail: string,
  ) {
    super(`${channel} delivery failed (HTTP ${status})${detail ? `: ${detail}` : ""}`);
    this.name = "ChannelDeliveryError";
  }
}

export async function postWithTimeout(args: {
  channel: string;
  fetchImpl: HttpFetch;
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  method?: "POST" | "PATCH";
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  let res;
  try {
    res = await args.fetchImpl(args.url, {
      method: args.method ?? "POST",
      headers: args.headers,
      body: args.body,
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === "AbortError" ? "timed out" : "network error";
    throw new ChannelDeliveryError(args.channel, 0, reason);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new ChannelDeliveryError(args.channel, res.status, sanitizeDetail(text));
  return text;
}

/** Keep provider error detail short and strip anything URL- or token-shaped. */
export function sanitizeDetail(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b(xox[a-z]-[A-Za-z0-9-]+|[A-Za-z0-9_-]{32,})\b/g, "<redacted>")
    .slice(0, 200)
    .trim();
}

/** Push-only channels can't take a decision back — and must not carry the
 *  approval token either (anyone reading the channel could replay it). */
export function decisionHint(n: { requestId: string | null; actions: ReadonlyArray<unknown> }): string {
  if (!n.requestId || n.actions.length === 0) return "";
  return "Decide in the Foreman TUI (`foreman start`) or in your Telegram chat.";
}

export function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
