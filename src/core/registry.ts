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

export type Transport = "stdio" | "ws" | "wrap";
export type AgentStatus = "active" | "inactive" | "blocked" | "disabled";

export interface AgentManifest {
  id: string;
  displayName: string;
  transport: Transport;
  endpoint?: string;
  metadata?: Record<string, unknown>;
  /** Optional caller-provided public key. If omitted, Foreman generates a keypair. */
  publicKey?: Buffer;
  /** LLM provider id for multi-provider agents. Single-provider agents leave NULL. */
  llmProvider?: string;
  /** #408 / #412 — Variant id within `llmProvider` (e.g. "via-openrouter"
   *  for Hermes/openai). NULL → defaults to the registry's
   *  `provider_mapping[llmProvider].preferred` at resolve time. */
  providerVariant?: string;
  /** #434 — Specific model id chosen for this agent (e.g.
   *  claude-opus-4-7, gpt-5-mini). NULL → projector uses the
   *  variant's hardcoded default from registry/agents.json. */
  modelVersion?: string;
  /** Free-text describing what the agent is for; surfaces in audit + approval. */
  responsibilityNote?: string;
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
  llmProvider: string | null;
  providerVariant: string | null;
  modelVersion: string | null;
  responsibilityNote: string | null;
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
        llmProvider: manifest.llmProvider ?? null,
        providerVariant: manifest.providerVariant ?? null,
        modelVersion: manifest.modelVersion ?? null,
        responsibilityNote: manifest.responsibilityNote ?? null,
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
    if (!row) return false;
    if (row.status === "blocked" || row.status === "disabled") return false;
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
      .where(
        and(ne(agents.status, "blocked"), ne(agents.status, "disabled")),
      )
      .all();
    return rows.map(toRegisteredAgent);
  }

  // Like list() but includes blocked rows — used by the TUI Agents page so the
  // user can see and unblock entries. The mediator + heartbeat paths stay on
  // list() so blocked agents remain quarantined from real traffic.
  listAll(): RegisteredAgent[] {
    const rows = this.db.select().from(agents).all();
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

  // Temporary pause — config + MCP wiring stay intact, but the mediator and
  // auth path reject requests. Use enable() to resume. Distinct from block(),
  // which is the "flagged as malicious" path.
  disable(agentId: string): void {
    const result = this.db
      .update(agents)
      .set({ status: "disabled" })
      .where(eq(agents.id, agentId))
      .run();
    if (result.changes === 0) throw new AgentNotFoundError(agentId);
  }

  enable(agentId: string): void {
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

  setLlmProvider(agentId: string, providerId: string | null): void {
    const existing = this.get(agentId);
    if (!existing) throw new AgentNotFoundError(agentId);
    this.db
      .update(agents)
      .set({ llmProvider: providerId })
      .where(eq(agents.id, agentId))
      .run();
    this.bus.emit("agent:config-updated", {
      agentId,
      llmProvider: providerId,
      responsibilityNote: existing.responsibilityNote,
      updatedAt: Date.now(),
    });
  }

  // #408 / #412 — Variant tracking. Set by the wizard (Phase 3) on
  // first install and by `foreman provider switch` later. NULL means
  // "use the registry's preferred variant for the active llmProvider".
  setProviderVariant(agentId: string, variantId: string | null): void {
    const existing = this.get(agentId);
    if (!existing) throw new AgentNotFoundError(agentId);
    this.db
      .update(agents)
      .set({ providerVariant: variantId })
      .where(eq(agents.id, agentId))
      .run();
    this.bus.emit("agent:config-updated", {
      agentId,
      llmProvider: existing.llmProvider,
      responsibilityNote: existing.responsibilityNote,
      updatedAt: Date.now(),
    });
  }

  // #434 — Set the per-agent model version override. NULL means
  // "use the variant's default model from registry/agents.json".
  setModelVersion(agentId: string, modelVersion: string | null): void {
    const existing = this.get(agentId);
    if (!existing) throw new AgentNotFoundError(agentId);
    this.db
      .update(agents)
      .set({ modelVersion })
      .where(eq(agents.id, agentId))
      .run();
    this.bus.emit("agent:config-updated", {
      agentId,
      llmProvider: existing.llmProvider,
      responsibilityNote: existing.responsibilityNote,
      updatedAt: Date.now(),
    });
  }

  setResponsibilityNote(agentId: string, note: string | null): void {
    const existing = this.get(agentId);
    if (!existing) throw new AgentNotFoundError(agentId);
    this.db
      .update(agents)
      .set({ responsibilityNote: note })
      .where(eq(agents.id, agentId))
      .run();
    this.bus.emit("agent:config-updated", {
      agentId,
      llmProvider: existing.llmProvider,
      responsibilityNote: note,
      updatedAt: Date.now(),
    });
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
    llmProvider: row.llmProvider,
    providerVariant: row.providerVariant,
    modelVersion: row.modelVersion,
    responsibilityNote: row.responsibilityNote,
  };
}
