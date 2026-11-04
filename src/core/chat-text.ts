// How text typed in a chat app becomes a Foreman command. A slash starts a
// command only when it starts a single word: `/foreman`, `/status`. A message
// can also open with a path (`/Users/me/app …`), and that is just a message.

export function isSlashCommand(text: string): boolean {
  return /^\/[^\s/]+(\s|$)/.test(text.trim());
}

/** The verb and its arguments. `/integrations` and `/integration …` are verbs
 *  of their own; a Telegram `@bot` suffix never reaches here (the channel
 *  strips it). */
export function parseChatCommand(text: string): string[] {
  const body = text.trim().replace(/^\/?foreman\b\s*/i, "");
  return (isSlashCommand(body) ? body.slice(1) : body).split(/\s+/).filter(Boolean);
}
