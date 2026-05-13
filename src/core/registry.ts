import { and, eq, ne } from "drizzle-orm";
import type { ForemanDb } from "../db/client.js";
import { agents } from "../db/schema.js";
import { generateKeypair } from "../identity/keypair.js";
import { verify } from "../identity/signing.js";
import {
  bus as defaultBus,
  type EventBus,
  type ForemanEventMap,
} from "./event-bus.js";

export type Transport = "stdio" | "ws";
export type AgentStatus = "active" | "inactive" | "blocked";

export interface AgentManifest {
  id: string;
  displayName: string;
  transport: Transport;
  endpoint?: string;
  metadata?: Record<string, unknown>;
  /** Optional caller-provided public key. If omitted, Foreman generates a keypair. */
  publicKey?: Buffer;
}

export interface RegisteredAgent {
  id: string;
  displayName: string;
  transport: Transport;
  endpoint: string | null;
  status: AgentStatus;
  registeredAt: number;
  lastSeenAt: number | null;
  metadata: Record<string, unknown> | null;
}

export interface RegisterResult {
  agent: RegisteredAgent;
  /** Set only when Foreman generated a fresh keypair. Caller must persist it. */
  privateKey?: Buffer;
}

export class AgentNotFoundError extends Error {
  constructor(public readonly agentId: string) {
    super(`Agent not found: ${agentId}`);
    this.name = "AgentNotFoundError";
  }
}

export class RegistryService {
  constructor(
    private readonly db: ForemanDb,
    private readonly bus: EventBus<ForemanEventMap> = defaultBus,
  ) {}

  register(manifest: AgentManifest): RegisterResult {
    const now = Date.now();
    let publicKey = manifest.publicKey;
    let privateKey: Buffer | undefined;
    if (!publicKey) {
      const kp = generateKeypair();
      publicKey = kp.publicKey;
      privateKey = kp.privateKey;
    }
    this.db
      .insert(agents)
      .values({
        id: manifest.id,
        displayName: manifest.displayName,
        publicKey,
        transport: manifest.transport,
        endpoint: manifest.endpoint ?? null,
        registeredAt: now,
        lastSeenAt: null,
        status: "active",
        metadata: manifest.metadata ? JSON.stringify(manifest.metadata) : null,
      })
      .run();
    const agent = this.requireAgent(manifest.id);
    this.bus.emit("agent:registered", {
      agentId: agent.id,
      displayName: agent.displayName,
      transport: agent.transport,
      registeredAt: agent.registeredAt,
    });
    return privateKey ? { agent, privateKey } : { agent };
  }

  authenticate(
    agentId: string,
    message: Buffer | string,
    signature: Buffer,
  ): boolean {
    const row = this.db
      .select({ publicKey: agents.publicKey, status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get();
    if (!row || row.status === "blocked") return false;
    try {
      return verify(message, signature, Buffer.from(row.publicKey));
    } catch {
      return false;
    }
  }

  list(): RegisteredAgent[] {
    const rows = this.db
      .select()
      .from(agents)
      .where(ne(agents.status, "blocked"))
      .all();
    return rows.map(toRegisteredAgent);
  }

  get(agentId: string): RegisteredAgent | null {
    const row = this.db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .get();
    return row ? toRegisteredAgent(row) : null;
  }

  heartbeat(agentId: string): void {
    const now = Date.now();
    const result = this.db
      .update(agents)
      .set({ lastSeenAt: now, status: "active" })
      .where(and(eq(agents.id, agentId), ne(agents.status, "blocked")))
      .run();
    if (result.changes === 0) throw new AgentNotFoundError(agentId);
    this.bus.emit("agent:heartbeat", {
      agentId,
      status: "active",
      seenAt: now,
    });
  }

  block(agentId: string): void {
    const result = this.db
      .update(agents)
      .set({ status: "blocked" })
      .where(eq(agents.id, agentId))
      .run();
    if (result.changes === 0) throw new AgentNotFoundError(agentId);
  }

  unblock(agentId: string): void {
    const result = this.db
      .update(agents)
      .set({ status: "active" })
      .where(eq(agents.id, agentId))
      .run();
    if (result.changes === 0) throw new AgentNotFoundError(agentId);
  }

  // Hard remove. Re-adding the same id afterwards yields a fresh keypair —
  // this is intentional per the issue #60 acceptance criteria.
  remove(agentId: string): void {
    const agent = this.get(agentId);
    if (!agent) throw new AgentNotFoundError(agentId);
    this.db.delete(agents).where(eq(agents.id, agentId)).run();
    this.bus.emit("agent:removed", {
      agentId,
      removedAt: Date.now(),
    });
  }

  // Rotates the agent's Ed25519 keypair. The returned private key MUST be
  // surfaced to the caller exactly once — Foreman never persists it.
  regenerateKey(agentId: string): { privateKey: Buffer; publicKey: Buffer } {
    const existing = this.get(agentId);
    if (!existing) throw new AgentNotFoundError(agentId);
    const kp = generateKeypair();
    this.db
      .update(agents)
      .set({ publicKey: kp.publicKey })
      .where(eq(agents.id, agentId))
      .run();
    this.bus.emit("agent:key-rotated", {
      agentId,
      rotatedAt: Date.now(),
    });
    return { privateKey: kp.privateKey, publicKey: kp.publicKey };
  }

  private requireAgent(agentId: string): RegisteredAgent {
    const agent = this.get(agentId);
    if (!agent) throw new AgentNotFoundError(agentId);
    return agent;
  }
}

function toRegisteredAgent(row: typeof agents.$inferSelect): RegisteredAgent {
  return {
    id: row.id,
    displayName: row.displayName,
    transport: row.transport,
    endpoint: row.endpoint,
    status: row.status,
    registeredAt: row.registeredAt,
    lastSeenAt: row.lastSeenAt,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, unknown>)
      : null,
  };
}
