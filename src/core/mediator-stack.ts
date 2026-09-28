import type { ForemanDb } from "../db/client.js";
import { claimedAgentOf } from "./agent-identity.js";
import type { ApprovalService } from "./approval.js";
import type { EventBus, ForemanEventMap } from "./event-bus.js";
import type { LlmVerifier } from "./llm/verifier.js";
import { MediatorService } from "./mediator.js";
import { PolicyEngine } from "./policy-engine.js";
import { RegistryService } from "./registry.js";
import { RiskScorer } from "./risk-scorer.js";
import type { SecretStore } from "./secret-store.js";
import { SessionManager } from "./session.js";

// =============================================================================
// Mediator stack factory
// =============================================================================
//
// Every entry point that gates an agent action (`foreman mcp-stdio`,
// `foreman wrap`, the Claude Code PreToolUse hook) needs the same five
// services wired the same way. They used to be assembled by hand in each
// command and had drifted apart — the hook path, for instance, never loaded
// policy.yaml. Building them here keeps policy, risk and audit behaviour
// identical no matter which door an agent comes through.

export interface MediatorStackOptions {
  db: ForemanDb;
  bus: EventBus<ForemanEventMap>;
  approval: ApprovalService;
  /** policy.yaml to follow: loaded now and re-read when it changes
   *  (#656). A version that doesn't parse leaves the last good policy in
   *  force and is reported once through `onPolicyError`. */
  policyPath?: string | null;
  onPolicyError?: (message: string) => void;
  secretStore?: SecretStore;
  verifier?: LlmVerifier;
}

export interface MediatorStack {
  registry: RegistryService;
  policy: PolicyEngine;
  risk: RiskScorer;
  sessionManager: SessionManager;
  mediator: MediatorService;
}

/** The responsibility note the risk rules check an agent against. An
 *  unverified `untrusted:<id>` connection is checked against <id>'s: those
 *  rules only ever add risk (cannot_access, can_use_services, …), so the
 *  restrictions follow the claimed id while no privilege does (#618). */
export function responsibilityLookup(
  registry: Pick<RegistryService, "get">,
): (agentId: string) => string | null {
  return (agentId) => registry.get(claimedAgentOf(agentId))?.responsibilityNote ?? null;
}

export function createMediatorStack(opts: MediatorStackOptions): MediatorStack {
  const { db, bus } = opts;
  const registry = new RegistryService(db, bus);
  const policy = new PolicyEngine(db, bus);
  if (opts.policyPath) policy.watchFile(opts.policyPath, opts.onPolicyError);
  const risk = new RiskScorer(db, undefined, {
    bucketOverrides: () => policy.getBucketOverrides(),
    getAgentResponsibility: responsibilityLookup(registry),
    responsibilityPolicies: () => policy.getResponsibilityPolicies(),
  });
  const sessionManager = new SessionManager(db, { bus });
  const mediator = new MediatorService({
    registry,
    policy,
    risk,
    approval: opts.approval,
    sessionManager,
    db,
    bus,
    ...(opts.secretStore ? { secretStore: opts.secretStore } : {}),
    ...(opts.verifier ? { verifier: opts.verifier } : {}),
  });
  return { registry, policy, risk, sessionManager, mediator };
}
