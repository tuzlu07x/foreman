// Agent identity on the MCP path (#618).
//
// `foreman mcp-stdio --source <id>` only names an agent; the agent's token
// (FOREMAN_AGENT_TOKEN) proves it. A connection that claims an id without a
// valid token runs as `untrusted:<claimed>`. That id matches no agent's
// policy rules, holds no org role, gets no MCP hub servers and can't
// delegate, while the claimed agent's block / pause still applies to it.

export const UNTRUSTED_PREFIX = "untrusted:";

/** What an agent id may look like: it lands in audit rows, the inbox,
 *  stderr and policy lookups. */
export const AGENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidAgentId(id: string): boolean {
  return AGENT_ID_RE.test(id);
}

/** An id safe to show on a terminal or in the inbox: control characters
 *  and ANSI escapes dropped, anything outside the id charset replaced. */
export function displayAgentId(id: string): string {
  const shown = id
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[^A-Za-z0-9._:-]/g, "?")
    .slice(0, 80);
  return shown.length > 0 ? shown : "?";
}

export function isUntrustedSource(sourceAgent: string | null | undefined): boolean {
  return typeof sourceAgent === "string" && sourceAgent.trim().toLowerCase().startsWith(UNTRUSTED_PREFIX);
}

export function untrustedSource(claimed: string): string {
  const id = claimed.trim();
  return isUntrustedSource(id) ? id : `${UNTRUSTED_PREFIX}${id}`;
}

/** The agent id a source claims to be: itself for a verified agent, the
 *  part after the prefix for an untrusted one. */
export function claimedAgentOf(sourceAgent: string): string {
  return isUntrustedSource(sourceAgent) ? sourceAgent.trim().slice(UNTRUSTED_PREFIX.length) : sourceAgent;
}
