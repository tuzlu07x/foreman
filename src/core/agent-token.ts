import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isUntrustedSource, untrustedSource } from "./agent-identity.js";
import { isHumanSource } from "./org/guard.js";
import {
  isReservedSecretName,
  RESERVED_SECRET_PREFIX,
  type SecretStore,
} from "./secret-store.js";

// Per-agent identity tokens for the MCP path (#618).
//
// `foreman agent add` / `rewire` mint a token, keep it in the encrypted
// secret store (under a reserved name nothing agent-facing can read) and
// write it into the agent's MCP wiring as an environment variable, never as
// a CLI argument. `foreman mcp-stdio` reads the variable, drops it from its
// own environment and resolves the agent from it. No token, a wrong token,
// or a token for a different agent than `--source` claims all resolve to
// `untrusted:<claimed>` — less privilege, never more.

export const AGENT_TOKEN_ENV = "FOREMAN_AGENT_TOKEN";
/** Alternative to the env var for agents that allow it: a 0600 file
 *  holding the token, so it isn't in the process environment at all. */
export const AGENT_TOKEN_FILE_ENV = "FOREMAN_AGENT_TOKEN_FILE";

export interface TokenIntake {
  /** Trimmed, or undefined when none was passed (or it was refused). */
  token: string | undefined;
  /** Why a token file was ignored; never contains the token. */
  problem?: string;
}

/**
 * Take the agent's token out of `env` (both variables are deleted, so
 * nothing this process starts inherits them) and trim it once here, so
 * every later comparison sees the same value. A token file must be a
 * regular, owner-only file (not a symlink).
 */
export function takeAgentToken(env: NodeJS.ProcessEnv): TokenIntake {
  const direct = env[AGENT_TOKEN_ENV];
  const file = env[AGENT_TOKEN_FILE_ENV];
  delete env[AGENT_TOKEN_ENV];
  delete env[AGENT_TOKEN_FILE_ENV];
  const trimmed = direct?.trim();
  if (trimmed) return { token: trimmed };
  if (!file) return { token: undefined };
  try {
    const stat = lstatSync(file);
    if (!stat.isFile()) return { token: undefined, problem: `${AGENT_TOKEN_FILE_ENV} is not a regular file` };
    if ((stat.mode & 0o077) !== 0) {
      return { token: undefined, problem: `${AGENT_TOKEN_FILE_ENV} is readable by others; chmod 600 it` };
    }
    const fromFile = readFileSync(file, "utf-8").trim();
    return fromFile ? { token: fromFile } : { token: undefined, problem: `${AGENT_TOKEN_FILE_ENV} is empty` };
  } catch {
    return { token: undefined, problem: `${AGENT_TOKEN_FILE_ENV} can't be read` };
  }
}

/** Recognisable prefix, so secret scanners and redaction can spot a leak. */
const TOKEN_PREFIX = "fat_";
const TOKEN_BYTES = 32;

export type AgentTokenStore = Pick<
  SecretStore,
  "getReserved" | "putReserved" | "exists" | "remove" | "list" | "meta"
>;

export class InvalidTokenAgentIdError extends Error {
  constructor(public readonly agentId: string) {
    super(`"${agentId}" can't hold an agent token: it is empty, reserved for you, or an untrusted id`);
    this.name = "InvalidTokenAgentIdError";
  }
}

export function agentTokenSecretName(agentId: string): string {
  return `${RESERVED_SECRET_PREFIX}${agentId}`;
}

export function mintAgentToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

/** Ids no agent may take: empty or padded, one of yours (`cli`, `tui`, …),
 *  or the `untrusted:` namespace. */
export function isReservedAgentId(agentId: string): boolean {
  return agentId.trim().length === 0 || agentId !== agentId.trim() || isHumanSource(agentId) || isUntrustedSource(agentId);
}

function assertTokenableAgentId(agentId: string): void {
  if (isReservedAgentId(agentId)) throw new InvalidTokenAgentIdError(agentId);
}

export function hasAgentToken(store: Pick<SecretStore, "exists">, agentId: string): boolean {
  return store.exists(agentTokenSecretName(agentId));
}

/** Mint a fresh token for `agentId`, replacing any previous one. The old
 *  token stops working at once. */
export function issueAgentToken(store: AgentTokenStore, agentId: string): string {
  assertTokenableAgentId(agentId);
  const token = mintAgentToken();
  store.putReserved(agentTokenSecretName(agentId), token);
  return token;
}

/** The agent's current token, minting one when it has none. */
export function ensureAgentToken(store: AgentTokenStore, agentId: string): string {
  assertTokenableAgentId(agentId);
  const name = agentTokenSecretName(agentId);
  if (store.exists(name)) return store.getReserved(name);
  return issueAgentToken(store, agentId);
}

export function revokeAgentToken(store: AgentTokenStore, agentId: string): boolean {
  const name = agentTokenSecretName(agentId);
  if (!store.exists(name)) return false;
  store.remove(name);
  return true;
}

/** Constant-time comparison. Hashing first gives both sides the same length,
 *  so neither the content nor the length of the stored token leaks. */
export function agentTokensEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db) && a.length > 0;
}

/** Does `presented` match the token stored for `agentId`? */
export function verifyAgentToken(store: AgentTokenStore, agentId: string, presented: string): boolean {
  const name = agentTokenSecretName(agentId);
  if (presented.length === 0) return false;
  try {
    return store.exists(name) && agentTokensEqual(store.getReserved(name), presented);
  } catch {
    return false; // a locked DB or undecryptable row: fail to untrusted
  }
}

/** The agent `presented` belongs to, or null. Every stored token is
 *  compared (no early exit), so timing doesn't reveal which one matched. */
export function findAgentByToken(store: AgentTokenStore, presented: string): string | null {
  if (presented.length === 0) return null;
  let owner: string | null = null;
  for (const { name } of store.list()) {
    if (!isReservedSecretName(name)) continue;
    let stored: string;
    try {
      stored = store.getReserved(name);
    } catch {
      continue;
    }
    if (agentTokensEqual(stored, presented) && owner === null) {
      owner = name.slice(RESERVED_SECRET_PREFIX.length);
    }
  }
  return owner;
}

export type IdentityReason = "token" | "no-token" | "invalid-token" | "token-mismatch";

export interface ResolvedIdentity {
  /** The id every check sees: the verified agent, or `untrusted:<claimed>`. */
  source: string;
  /** What `--source` said (or the default when it said nothing). */
  claimed: string;
  trusted: boolean;
  reason: IdentityReason;
}

export const DEFAULT_CLAIMED_SOURCE = "mcp-client";

/**
 * Who is on the other end of an MCP connection. `claimed` is `--source`
 * (undefined when not given), `token` is FOREMAN_AGENT_TOKEN. Only a token
 * stored for an agent proves that agent; when `--source` is given it must
 * name the same agent. Everything else is `untrusted:<claimed>`.
 */
export function resolveAgentIdentity(input: {
  claimed?: string | undefined;
  token?: string | undefined;
  store: AgentTokenStore;
}): ResolvedIdentity {
  const claimed = input.claimed?.trim() || DEFAULT_CLAIMED_SOURCE;
  const untrusted = (reason: IdentityReason): ResolvedIdentity => ({
    source: untrustedSource(claimed),
    claimed,
    trusted: false,
    reason,
  });
  const token = input.token?.trim() ?? "";
  if (token.length === 0) return untrusted("no-token");
  let owner: string | null;
  try {
    owner = findAgentByToken(input.store, token);
  } catch {
    owner = null; // the store failed: fail to untrusted, never to trusted
  }
  if (owner === null || isHumanSource(owner) || isUntrustedSource(owner)) return untrusted("invalid-token");
  if (input.claimed !== undefined && input.claimed.trim() !== owner) return untrusted("token-mismatch");
  return { source: owner, claimed: input.claimed?.trim() || owner, trusted: true, reason: "token" };
}

/** Still the same agent? A verified identity whose token was rotated or
 *  revoked since the connection started drops to `untrusted:<agent>`. An
 *  untrusted identity never climbs back up within a connection. Returns
 *  `identity` itself when nothing changed. */
export function recheckAgentIdentity(
  identity: ResolvedIdentity,
  token: string,
  store: AgentTokenStore,
): ResolvedIdentity {
  if (!identity.trusted || verifyAgentToken(store, identity.source, token)) return identity;
  return { source: untrustedSource(identity.source), claimed: identity.source, trusted: false, reason: "invalid-token" };
}

/** One line for stderr, the inbox and `doctor`. Never includes the token. */
export function describeUntrustedIdentity(identity: ResolvedIdentity): string {
  const why =
    identity.reason === "no-token"
      ? `no ${AGENT_TOKEN_ENV} was passed`
      : identity.reason === "invalid-token"
        ? `its ${AGENT_TOKEN_ENV} matches no agent (rotated or revoked?)`
        : `its ${AGENT_TOKEN_ENV} belongs to a different agent`;
  const fix =
    identity.claimed === DEFAULT_CLAIMED_SOURCE
      ? "Fix: register it with `foreman agent add` so its MCP wiring carries a token"
      : `Fix: foreman agent rewire ${identity.claimed}`;
  return (
    `'${identity.claimed}' connected without proof of identity (${why}), so it runs as ` +
    `${identity.source}, without that agent's allow rules, org role or MCP hub servers. ${fix}`
  );
}
