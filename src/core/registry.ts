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
  /** #517 Faz 3 — Operator has trusted this agent to bypass its
   *  shell-tool allowlist (`foreman agent trust <id>`). When true,
   *  the spawn engine appends the registry's
   *  `task_skip_permissions_flag` so the agent runs without prompting
   *  for individual shell calls. Foreman's MCP-level mediation
   *  remains the security boundary. */
  taskSkipPermissions: boolean;
  /** Responsibility-based auto-routing — role bucket the agent
   *  participates in within a flow. NULL = no flow participation
   *  (agent stays in classic one-shot mode). */
  role: string | null;
  /** Raw JSON array of handoff rules; the FlowRouter parses this when
   *  classifying an output to decide the next step. NULL = no rules,
   *  output falls through to orchestrator summarization. */
  handoffRules: string | null;
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

/** #524 — Result shape for `RegistryService.findByCommandToken`. The
 *  ambiguous case surfaces the candidate ids so the LLM fallback can hint
 *  "did you mean a or b?" without re-running the lookup. */
export type AgentLookupResult =
  | { kind: "match"; agent: RegisteredAgent }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

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

  /** #524 — Look up an active agent by the first token of a free-form
   *  chat message ("OpenClaw, todo app yap" → agent `openclaw`).
   *
   *  - Case-insensitive exact match against `id` and `displayName`. No
   *    substring matching (would surprise-route "Code" → "claude-code").
   *  - No fuzzy / typo tolerance — silent surprise routing is worse than
   *    a clear "unknown command".
   *  - Returns `ambiguous` when more than one active agent shares the same
   *    case-folded id or displayName; callers fall through to the LLM
   *    fallback with a clarifying hint.
   *  - Blocked / disabled agents are NOT considered (uses the same
   *    `list()` filter as the mediator). A `foreman agent remove
   *    openclaw` makes "openclaw foo" fall through to the LLM, not route
   *    to a removed agent. */
  findByCommandToken(token: string): AgentLookupResult {
    const needle = token.toLowerCase().trim();
    if (!needle) return { kind: "none" };
    const matches: RegisteredAgent[] = [];
    for (const agent of this.list()) {
      if (
        agent.id.toLowerCase() === needle ||
        agent.displayName.toLowerCase() === needle
      ) {
        matches.push(agent);
      }
    }
    if (matches.length === 0) return { kind: "none" };
    if (matches.length === 1) return { kind: "match", agent: matches[0]! };
    return {
      kind: "ambiguous",
      candidates: matches.map((a) => a.id),
    };
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

  /** #517 Faz 3 — Flip the `task_skip_permissions` flag. `foreman agent
   *  trust <id>` wires the user's "I trust this agent + accept MCP-level
   *  mediation as the only boundary" decision. The spawn engine checks
   *  the flag at task time + appends the agent's
   *  `task_skip_permissions_flag` from the catalog when set. */
  setTaskSkipPermissions(agentId: string, trusted: boolean): void {
    const result = this.db
      .update(agents)
      .set({ taskSkipPermissions: trusted ? 1 : 0 })
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

  /** Auto-routing — set the agent's role bucket. Allowed values:
   *  'coder' | 'reviewer' | 'orchestrator' | 'custom' | null (opt-out).
   *  Throws AgentNotFoundError if the agent isn't registered. */
  setRole(agentId: string, role: string | null): void {
    const existing = this.get(agentId);
    if (!existing) throw new AgentNotFoundError(agentId);
    this.db
      .update(agents)
      .set({ role })
      .where(eq(agents.id, agentId))
      .run();
  }

  /** Auto-routing — replace the agent's handoff_rules JSON array.
   *  Pass null to clear. Caller is responsible for shape validation
   *  (the FlowRouter's parseHandoffRules filters malformed entries). */
  setHandoffRules(agentId: string, rulesJson: string | null): void {
    const existing = this.get(agentId);
    if (!existing) throw new AgentNotFoundError(agentId);
    this.db
      .update(agents)
      .set({ handoffRules: rulesJson })
      .where(eq(agents.id, agentId))
      .run();
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
    taskSkipPermissions: row.taskSkipPermissions === 1,
    role: row.role,
    handoffRules: row.handoffRules,
  };
}
