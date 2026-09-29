// =============================================================================
// Paste-time format checks for the wizard's endpoint and service prompts (#657)
// =============================================================================
//
// The wizard took `notatoken` as a Telegram bot token and `not a url` as a
// custom endpoint without a word; the mistake only surfaced later as a
// failed delivery. These never refuse a value outright, since a self-hosted
// or unusual setup may legitimately differ: an endpoint is saved with a
// warning (like the provider key check, setup-wizard-key-validation.ts); a
// service secret is held back until it is submitted a second time
// (applyServiceValueSubmit), so a wrong paste is caught before it is stored.

/** A warning for an endpoint that isn't an http(s) URL, else null. */
export function endpointPasteWarning(value: string): string | null {
  const trimmed = value.trim();
  let ok = false;
  try {
    const url = new URL(trimmed);
    ok = (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    ok = false;
  }
  return ok
    ? null
    : `"${trimmed}" doesn't look like an http(s) URL (e.g. https://api.example.com/v1). Saved anyway — change it on the Providers page if that was a typo.`;
}

interface ServiceFormat {
  test: RegExp;
  what: string;
  example: string;
}

/** Shapes of the service secrets the catalog asks for, by secret name. */
const SERVICE_FORMATS: Record<string, ServiceFormat> = {
  "telegram-bot-token": {
    test: /^\d{5,}:[A-Za-z0-9_-]{30,}$/,
    what: "a Telegram bot token",
    example: "123456789:ABC-DEF1234…",
  },
  "telegram-chat-id": {
    test: /^(-?\d+|@[A-Za-z0-9_]{5,})$/,
    what: "a Telegram chat id",
    example: "123456789, or -1001234567890 for a group",
  },
  "slack-bot-token": { test: /^xoxb-[A-Za-z0-9-]+$/, what: "a Slack bot token", example: "xoxb-…" },
  "discord-bot-token": {
    test: /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/,
    what: "a Discord bot token",
    example: "three dot-separated parts",
  },
  "github-pat": {
    test: /^(ghp_|github_pat_|gho_|ghu_|ghs_)[A-Za-z0-9_]{20,}$/,
    what: "a GitHub token",
    example: "ghp_… or github_pat_…",
  },
  "notion-integration-token": {
    test: /^(secret_|ntn_)[A-Za-z0-9]{20,}$/,
    what: "a Notion integration token",
    example: "ntn_… or secret_…",
  },
};

interface LookAlike {
  test: RegExp;
  /** What the pasted value is. */
  is: string;
}

/** The other values on the same settings pages, pasted by mistake: say what
 *  was pasted, then where the right one is (real-services test, 2.3.0: an
 *  `xapp-` token for Slack, the Application ID and Public Key for Discord). */
const LOOK_ALIKES: Record<string, { where: string; values: LookAlike[] }> = {
  "slack-bot-token": {
    where: "the bot token (xoxb-…) is under api.slack.com/apps → your app → OAuth & Permissions → Bot User OAuth Token",
    values: [
      { test: /^xapp-/, is: "Slack's app-level token (xapp-…), which two-way Slack uses later" },
      { test: /^xoxp-/, is: "a Slack user token (xoxp-…)" },
      { test: /^xoxe/, is: "a Slack refresh or config token" },
    ],
  },
  "discord-bot-token": {
    where: "the bot token is under discord.com/developers → your app → Bot → Reset Token → Copy (three dot-separated parts)",
    values: [
      { test: /^\d{17,20}$/, is: "the Application ID" },
      { test: /^[0-9a-f]{64}$/i, is: "the Public Key" },
      { test: /^[A-Za-z0-9_-]{32}$/, is: "probably the OAuth2 Client Secret" },
    ],
  },
  "telegram-bot-token": {
    where: "the bot token (123456789:ABC-…) is what @BotFather sent when you created the bot",
    values: [{ test: /^-?\d+$/, is: "a chat id" }],
  },
  "telegram-chat-id": {
    where: "the chat id is a number: message your bot, then open api.telegram.org/bot<token>/getUpdates, or ask @userinfobot",
    values: [{ test: /^\d{5,}:[A-Za-z0-9_-]{30,}$/, is: "the bot token" }],
  },
};

/** A warning when a pasted service secret doesn't have its usual shape,
 *  else null (also for secrets with no known shape). The caller says what
 *  happens next (held back, or saved anyway). */
export function servicePasteWarning(secretName: string, value: string): string | null {
  const format = SERVICE_FORMATS[secretName];
  const v = value.trim();
  if (!format || format.test.test(v)) return null;
  const known = LOOK_ALIKES[secretName];
  const alike = known?.values.find((a) => a.test.test(v));
  if (known && alike) return `that's ${alike.is}, not ${format.what}: ${known.where}.`;
  return `that doesn't look like ${format.what} (${format.example}).`;
}
