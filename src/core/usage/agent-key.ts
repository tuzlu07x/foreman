import { createHmac, timingSafeEqual } from "node:crypto";

// A per-agent key (#657) for agents you start yourself. `usage env` used to
// hand every agent the same install key, with the agent id in the payload,
// so any of them could report as any other. An agent key names its agent
// and is an HMAC of that id under the install key: the receiver books what
// arrives with it to that agent, whatever the payload claims.
const AGENT_KEY_PREFIX = "u1.";

export function agentUsageKey(installKey: string, agentId: string): string {
  const id = safe(agentId.toLowerCase());
  return `${AGENT_KEY_PREFIX}${id}.${agentKeyMac(installKey, id)}`;
}

/** The agent a per-agent key belongs to, or null when it isn't a valid
 *  one for this install. Constant-time on the MAC. */
export function agentForUsageKey(installKey: string, key: string): string | null {
  if (!key.startsWith(AGENT_KEY_PREFIX)) return null;
  const rest = key.slice(AGENT_KEY_PREFIX.length);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = rest.slice(0, dot);
  if (safe(id) !== id) return null;
  const given = Buffer.from(rest.slice(dot + 1));
  const expected = Buffer.from(agentKeyMac(installKey, id));
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
}

function agentKeyMac(installKey: string, agentId: string): string {
  return createHmac("sha256", installKey).update(`foreman-usage-agent:${agentId}`).digest("hex");
}

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
}
