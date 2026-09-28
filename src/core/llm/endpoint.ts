// Base URLs for the self-hosted brains (Ollama, OpenAI-compatible). The
// runtime client, the wizard and `foreman doctor` all go through here so a
// URL that one of them accepts is a URL the others accept too.

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";

export type BaseUrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/** Validate and normalise a base URL: http(s) only, no embedded
 *  credentials, query or fragment (paths get appended to it), and no
 *  trailing slash. Reasons never echo the value: it may come from the
 *  secret store. */
export function checkLlmBaseUrl(raw: string): BaseUrlCheck {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "the URL is empty" };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "it is not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      reason: `"${url.protocol}" is not allowed — use an http:// or https:// URL`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      reason:
        "the URL must not contain a username or password — store an API key instead",
    };
  }
  if (url.search !== "" || url.hash !== "") {
    return {
      ok: false,
      reason: "the URL must not contain a query string or fragment",
    };
  }
  return { ok: true, url: url.toString().replace(/\/+$/, "") };
}

/** Ollama's native API root (`/api/tags` lives here), accepting a base URL
 *  given with or without the `/v1` suffix of its OpenAI-compatible API. */
export function ollamaApiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Base of Ollama's OpenAI-compatible API (`/chat/completions`, `/models`). */
export function ollamaOpenAiBase(baseUrl: string): string {
  return `${ollamaApiRoot(baseUrl)}/v1`;
}

/** True for loopback hosts, where a keyless Ollama normally runs. */
export function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return (
      host === "localhost" ||
      host === "[::1]" ||
      host === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(host)
    );
  } catch {
    return false;
  }
}
