import { ulid } from "ulid";
import type { MCPGateway } from "../mcp/gateway.js";
import type { JSONRPCMessage, JSONRPCRequest } from "../mcp/types.js";
import type { ApprovalService } from "./approval.js";
import {
  bus as defaultBus,
  type EventBus,
  type ForemanEventMap,
} from "./event-bus.js";
import type { PolicyEngine } from "./policy-engine.js";
import { type RiskScorer } from "./risk-scorer.js";
import type {
  LlmVerification,
  RiskAssessment,
  RiskBucket,
  RiskFactor,
} from "./risk-rules/types.js";
import { combineAssessment, type LlmVerifier } from "./llm/verifier.js";
import { contextFromAssessment } from "./llm/prompts.js";
import { generateReport, type SecurityReport } from "./security-report.js";
import type { RegistryService } from "./registry.js";
import { eq } from "drizzle-orm";
import type { ForemanDb } from "../db/client.js";
import { requests } from "../db/schema.js";
import type { SessionManager } from "./session.js";
import { SecretNotFoundError, type SecretStore } from "./secret-store.js";

export interface MediatorInput {
  requestId?: string;
  sourceAgent: string;
  message: JSONRPCMessage;
  targetAgent?: string;
  targetTool?: string;
  signedPayload?: Buffer | string;
  signature?: Buffer;
  sessionId?: string;
  tokenCount?: number;
  /** Request that triggered this one (#301). When an agent's tool call is
   *  forwarded to a downstream agent (e.g. OpenClaw → Hermes delegation),
   *  the downstream's MediatorInput sets this to the original requestId so
   *  the audit log can render the chain as a tree. Null/absent for
   *  first-in-chain calls. */
  parentRequestId?: string;
}

export interface MediatorOutput {
  requestId: string;
  decision: "allowed" | "denied";
  decidedBy: string;
  riskScore: number;
  riskReasons: string[];
  riskFactors: RiskFactor[];
  riskBucket: RiskBucket;
  llmVerification: LlmVerification | null;
  result?: unknown;
  durationMs: number;
}

export interface MediatorDeps {
  registry: RegistryService;
  policy: PolicyEngine;
  risk: RiskScorer;
  approval: ApprovalService;
  gateway?: MCPGateway;
  sessionManager?: SessionManager;
  db?: ForemanDb;
  bus?: EventBus<ForemanEventMap>;
  timeoutMs?: number;
  secretStore?: SecretStore;
  /** Optional LLM verifier (#231 / C8). When set + enabled in llm.yaml,
   *  flagged calls get a second-opinion before the modal opens. */
  verifier?: LlmVerifier;
}

export interface SecretGetInput {
  sourceAgent: string;
  secretName: string;
  requestId?: string;
}

export interface SecretGetOutput {
  requestId: string;
  decision: "allowed" | "denied";
  decidedBy: string;
  value?: string;
  error?: string;
}

export class SecretStoreNotConfiguredError extends Error {
  constructor() {
    super("MediatorService.handleSecretGet() requires deps.secretStore");
    this.name = "SecretStoreNotConfiguredError";
  }
}

export class ReplayNotSupportedError extends Error {
  constructor() {
    super("MediatorService.replay() requires deps.db");
    this.name = "ReplayNotSupportedError";
  }
}

export class RequestNotFoundError extends Error {
  constructor(public readonly requestId: string) {
    super(`No request: ${requestId}`);
    this.name = "RequestNotFoundError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class MediatorService {
  private readonly bus: EventBus<ForemanEventMap>;
  private readonly timeoutMs: number;

  constructor(private readonly deps: MediatorDeps) {
    this.bus = deps.bus ?? defaultBus;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async handleRequest(input: MediatorInput): Promise<MediatorOutput> {
    const requestId = input.requestId ?? ulid();
    const createdAt = Date.now();
    const emptyAssessment = makeEmptyAssessment();

    if (!this.authenticate(input)) {
      return this.finalize({
        requestId,
        input,
        decision: "denied",
        decidedBy: "auth-failure",
        assessment: emptyAssessment,
        createdAt,
      });
    }

    if (
      input.sessionId &&
      this.deps.sessionManager?.isHalted(input.sessionId)
    ) {
      return this.finalize({
        requestId,
        input,
        decision: "denied",
        decidedBy: "session:halted",
        assessment: emptyAssessment,
        createdAt,
      });
    }

    const policyResult = this.deps.policy.evaluate({
      sourceAgent: input.sourceAgent,
      targetAgent: input.targetAgent,
      targetTool: input.targetTool,
      args: this.argsFromMessage(input.message),
    });

    if (policyResult.decision === "deny") {
      return this.finalize({
        requestId,
        input,
        decision: "denied",
        decidedBy: `policy:${policyResult.matchedRuleId ?? "unknown"}`,
        assessment: emptyAssessment,
        createdAt,
      });
    }

    const heuristic = this.deps.risk.assess({
      sourceAgent: input.sourceAgent,
      targetAgent: input.targetAgent,
      targetTool: input.targetTool,
      args: this.argsFromMessage(input.message),
      sessionId: input.sessionId,
    });

    // Optional LLM verification pass — short-circuits gracefully when off /
    // below threshold / over budget / cached. Combine folds the verdict back
    // into the assessment (overrides recommendation only when confidence ≥0.7).
    let assessment: RiskAssessment = heuristic;
    if (this.deps.verifier) {
      try {
        const ctx = contextFromAssessment({
          assessment: heuristic,
          sourceAgent: input.sourceAgent,
          targetAgent: input.targetAgent,
          targetTool: input.targetTool,
          callArgs: this.argsFromMessage(input.message),
        });
        const verdict = await this.deps.verifier.verify(ctx, requestId);
        assessment = combineAssessment(heuristic, verdict);
      } catch {
        // Best-effort — any unexpected verifier error falls back to heuristic.
        assessment = heuristic;
      }
    }

    // Build the SecurityReport from the (possibly LLM-augmented) assessment
    // so the modal + audit row + future renderers all consume one shape.
    // Failures here must not block the call — fall back to a null report and
    // the modal will use its legacy factor rendering.
    let securityReport: SecurityReport | null = null;
    try {
      securityReport = generateReport({
        sourceAgent: input.sourceAgent,
        targetAgent: input.targetAgent,
        targetTool: input.targetTool,
        args: this.argsFromMessage(input.message),
        assessment,
      });
    } catch {
      securityReport = null;
    }

    let decision: "allowed" | "denied";
    let decidedBy: string;

    // Heuristic recommendation drives the gate; an explicit policy `ask`
    // always escalates even when the score lands in the auto-allow bucket.
    if (assessment.recommendation === "deny") {
      return this.finalize({
        requestId,
        input,
        decision: "denied",
        decidedBy: `risk:${assessment.bucket}`,
        assessment,
        createdAt,
      });
    }

    const riskReasons = assessment.factors.map((f) => f.rule);
    const needsApproval =
      policyResult.decision === "ask" || assessment.recommendation === "ask";

    if (needsApproval) {
      this.bus.emit("approval:requested", {
        requestId,
        sourceAgent: input.sourceAgent,
        targetAgent: input.targetAgent,
        targetTool: input.targetTool,
        args: this.argsFromMessage(input.message),
        riskScore: assessment.totalScore,
        riskReasons,
        riskFactors: assessment.factors,
        riskBucket: assessment.bucket,
        llmVerification: assessment.llmVerification,
        securityReport,
        sessionId: input.sessionId,
      });
      const approval = await this.deps.approval.request({
        requestId,
        sourceAgent: input.sourceAgent,
        targetAgent: input.targetAgent,
        targetTool: input.targetTool,
        args: this.argsFromMessage(input.message),
        riskScore: assessment.totalScore,
        riskReasons,
        riskFactors: assessment.factors,
        riskBucket: assessment.bucket,
        llmVerification: assessment.llmVerification,
        securityReport,
        sessionId: input.sessionId,
      });
      decision = approval.decision;
      // #302 — surface the channel that resolved the approval so the audit
      // log distinguishes Telegram-resolved from TUI-resolved decisions.
      decidedBy = approval.via ? `user:${approval.via}` : "user";
      if (approval.remember && input.targetTool) {
        const target = input.targetAgent
          ? `${input.targetAgent}:${input.targetTool}`
          : `tool:${input.targetTool}`;
        this.deps.policy.remember({
          sourceAgent: input.sourceAgent,
          target,
          effect: approval.remember,
        });
      }
    } else {
      decision = "allowed";
      decidedBy = policyResult.matchedRuleId
        ? `policy:${policyResult.matchedRuleId}`
        : "auto";
    }

    if (decision === "allowed" && input.sessionId && this.deps.sessionManager) {
      const turn = this.deps.sessionManager.recordTurn(
        input.sessionId,
        input.tokenCount ?? 0,
      );
      if (!turn.allowed) {
        decision = "denied";
        decidedBy = `session:${turn.reason ?? "halted"}`;
      }
    }

    let result: unknown | undefined;
    if (decision === "allowed" && input.targetAgent && this.deps.gateway) {
      try {
        result = await this.forwardToTarget(input.targetAgent, input.message);
      } catch (err) {
        decision = "denied";
        decidedBy = "route-error";
        result = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    return this.finalize({
      requestId,
      input,
      decision,
      decidedBy,
      assessment,
      createdAt,
      result,
      securityReport,
    });
  }

  // Secret access bypasses risk scoring and the approval modal — policy is the
  // only gate. Audit row is still written via request:decided so log search
  // covers it.
  async handleSecretGet(input: SecretGetInput): Promise<SecretGetOutput> {
    if (!this.deps.secretStore) throw new SecretStoreNotConfiguredError();
    const requestId = input.requestId ?? ulid();
    const createdAt = Date.now();
    const args = { name: input.secretName };

    const evaluation = this.deps.policy.evaluateSecretAccess(
      input.sourceAgent,
      input.secretName,
    );

    if (evaluation.decision !== "allow") {
      this.emitSecretDecision({
        requestId,
        sourceAgent: input.sourceAgent,
        args,
        decision: "denied",
        decidedBy: evaluation.decidedBy,
        createdAt,
      });
      return {
        requestId,
        decision: "denied",
        decidedBy: evaluation.decidedBy,
      };
    }

    let value: string | undefined;
    let decision: "allowed" | "denied" = "allowed";
    let decidedBy = evaluation.decidedBy;
    let errorMessage: string | undefined;
    try {
      value = this.deps.secretStore.get(input.secretName);
    } catch (err) {
      decision = "denied";
      decidedBy =
        err instanceof SecretNotFoundError
          ? "secret-store:not-found"
          : "secret-store:error";
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    this.emitSecretDecision({
      requestId,
      sourceAgent: input.sourceAgent,
      args,
      decision,
      decidedBy,
      createdAt,
      result: decision === "allowed" ? { ok: true } : { error: errorMessage },
    });

    return {
      requestId,
      decision,
      decidedBy,
      value,
      error: errorMessage,
    };
  }

  async replay(requestId: string): Promise<MediatorOutput> {
    if (!this.deps.db) throw new ReplayNotSupportedError();
    const row = this.deps.db
      .select()
      .from(requests)
      .where(eq(requests.id, requestId))
      .get();
    if (!row) throw new RequestNotFoundError(requestId);
    const args = safeJsonParse(row.args);
    return this.handleRequest({
      sourceAgent: row.sourceAgent,
      targetAgent: row.targetAgent ?? undefined,
      targetTool: row.targetTool ?? undefined,
      message: {
        jsonrpc: "2.0",
        id: 0,
        method: row.targetTool ? "tools/call" : "unknown",
        params: row.targetTool
          ? { name: row.targetTool, arguments: args }
          : args,
      } as JSONRPCMessage,
    });
  }

  private authenticate(input: MediatorInput): boolean {
    if (!input.signature || input.signedPayload === undefined) return true;
    return this.deps.registry.authenticate(
      input.sourceAgent,
      input.signedPayload,
      input.signature,
    );
  }

  private argsFromMessage(message: JSONRPCMessage): unknown {
    if (!("params" in message)) return undefined;
    const params = message.params as { arguments?: unknown } | undefined;
    return params?.arguments ?? params;
  }

  private forwardToTarget(
    targetAgent: string,
    message: JSONRPCMessage,
  ): Promise<unknown> {
    const gateway = this.deps.gateway;
    if (!gateway) {
      return Promise.reject(new Error("No gateway configured"));
    }
    if (!("id" in message) || !("method" in message)) {
      return Promise.reject(new Error("Only requests can be forwarded"));
    }
    const expectedId = (message as JSONRPCRequest).id;
    return new Promise((resolve, reject) => {
      let off: (() => void) | null = null;
      const timer = setTimeout(() => {
        off?.();
        reject(new Error(`Timeout waiting for response from ${targetAgent}`));
      }, this.timeoutMs);
      off = this.bus.on("agent:message", (e) => {
        if (e.agentId !== targetAgent) return;
        const msg = e.message as JSONRPCMessage;
        if (!("id" in msg) || msg.id !== expectedId) return;
        clearTimeout(timer);
        off?.();
        if ("result" in msg) resolve(msg.result);
        else if ("error" in msg) {
          reject(
            new Error(
              typeof msg.error === "object" &&
                msg.error !== null &&
                "message" in msg.error
                ? String((msg.error as { message: unknown }).message)
                : JSON.stringify(msg.error),
            ),
          );
        } else resolve(undefined);
      });
      try {
        gateway.send(targetAgent, message);
      } catch (err) {
        clearTimeout(timer);
        off?.();
        reject(err);
      }
    });
  }

  private emitSecretDecision(args: {
    requestId: string;
    sourceAgent: string;
    args: unknown;
    decision: "allowed" | "denied";
    decidedBy: string;
    createdAt: number;
    result?: unknown;
  }): void {
    const decidedAt = Date.now();
    this.bus.emit("request:decided", {
      requestId: args.requestId,
      sourceAgent: args.sourceAgent,
      targetAgent: "foreman",
      targetTool: "secrets/get",
      args: args.args,
      decision: args.decision,
      decidedBy: args.decidedBy,
      riskScore: 0,
      riskReasons: [],
      riskFactors: [],
      riskBucket: "low",
      llmVerification: null,
      securityReport: null,
      result: args.result,
      durationMs: decidedAt - args.createdAt,
      createdAt: args.createdAt,
      decidedAt,
    });
  }

  private finalize(args: {
    requestId: string;
    input: MediatorInput;
    decision: "allowed" | "denied";
    decidedBy: string;
    assessment: RiskAssessment;
    createdAt: number;
    result?: unknown;
    securityReport?: SecurityReport | null;
  }): MediatorOutput {
    const decidedAt = Date.now();
    const durationMs = decidedAt - args.createdAt;
    const riskReasons = args.assessment.factors.map((f) => f.rule);
    // If the caller didn't pre-compute a report, derive one now so the audit
    // row always carries a payload (early-exit paths like auth-failure or
    // policy-deny pass null which yields a minimal heuristic-only report).
    const securityReport: SecurityReport | null =
      args.securityReport !== undefined
        ? args.securityReport
        : safeBuildReport(args.input, args.assessment);
    this.bus.emit("request:decided", {
      requestId: args.requestId,
      sourceAgent: args.input.sourceAgent,
      targetAgent: args.input.targetAgent,
      targetTool: args.input.targetTool,
      args: this.argsFromMessage(args.input.message),
      decision: args.decision,
      decidedBy: args.decidedBy,
      riskScore: args.assessment.totalScore,
      riskReasons,
      riskFactors: args.assessment.factors,
      riskBucket: args.assessment.bucket,
      llmVerification: args.assessment.llmVerification,
      securityReport,
      result: args.result,
      durationMs,
      createdAt: args.createdAt,
      decidedAt,
      // #301 — agent-to-agent flow tracking. Whatever the caller passed in
      // gets emitted so the audit listener can persist the parent/session
      // links.
      parentRequestId: args.input.parentRequestId,
      sessionId: args.input.sessionId,
    });
    return {
      requestId: args.requestId,
      decision: args.decision,
      decidedBy: args.decidedBy,
      riskScore: args.assessment.totalScore,
      riskReasons,
      riskFactors: args.assessment.factors,
      riskBucket: args.assessment.bucket,
      llmVerification: args.assessment.llmVerification,
      result: args.result,
      durationMs,
    };
  }
  private argsFromMessageForReport(input: MediatorInput): unknown {
    return this.argsFromMessage(input.message);
  }
}

function safeBuildReport(
  input: MediatorInput,
  assessment: RiskAssessment,
): SecurityReport | null {
  try {
    return generateReport({
      sourceAgent: input.sourceAgent,
      targetAgent: input.targetAgent,
      targetTool: input.targetTool,
      args: (input.message as { params?: { arguments?: unknown } })?.params
        ?.arguments,
      assessment,
    });
  } catch {
    return null;
  }
}

function makeEmptyAssessment(): RiskAssessment {
  return {
    factors: [],
    totalScore: 0,
    bucket: "low",
    recommendation: "allow",
    llmVerification: null,
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
