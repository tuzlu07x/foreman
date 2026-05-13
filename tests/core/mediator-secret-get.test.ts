import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BusApprovalService } from "../../src/core/approval.js";
import { EventBus, type ForemanEventMap } from "../../src/core/event-bus.js";
import {
  MediatorService,
  SecretStoreNotConfiguredError,
} from "../../src/core/mediator.js";
import { PolicyEngine } from "../../src/core/policy-engine.js";
import { RegistryService } from "../../src/core/registry.js";
import { RiskScorer } from "../../src/core/risk-scorer.js";
import { SecretStore } from "../../src/core/secret-store.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";
import { generateMasterKey } from "../../src/identity/encryption.js";

function buildMediator(
  db: ForemanDb,
  bus: EventBus<ForemanEventMap>,
  store: SecretStore,
): { mediator: MediatorService; policy: PolicyEngine } {
  const policy = new PolicyEngine(db, bus);
  const mediator = new MediatorService({
    registry: new RegistryService(db, bus),
    policy,
    risk: new RiskScorer(db),
    approval: new BusApprovalService({ bus, timeoutMs: 100 }),
    db,
    bus,
    secretStore: store,
  });
  return { mediator, policy };
}

describe("MediatorService.handleSecretGet", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let bus: EventBus<ForemanEventMap>;
  let store: SecretStore;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    bus = new EventBus<ForemanEventMap>();
    store = new SecretStore(db, generateMasterKey());
  });

  afterEach(() => sqlite.close());

  it("throws SecretStoreNotConfiguredError when deps.secretStore is missing", async () => {
    const policy = new PolicyEngine(db, bus);
    const mediator = new MediatorService({
      registry: new RegistryService(db, bus),
      policy,
      risk: new RiskScorer(db),
      approval: new BusApprovalService({ bus, timeoutMs: 100 }),
      db,
      bus,
    });
    await expect(
      mediator.handleSecretGet({ sourceAgent: "hermes", secretName: "k" }),
    ).rejects.toBeInstanceOf(SecretStoreNotConfiguredError);
  });

  it("denies deny-by-default when no policy rule grants access (no approval modal)", async () => {
    store.add("anthropic-key", "sk-abc");
    const { mediator } = buildMediator(db, bus, store);
    let approvalEvents = 0;
    bus.on("approval:requested", () => approvalEvents++);

    const out = await mediator.handleSecretGet({
      sourceAgent: "rogue-agent",
      secretName: "anthropic-key",
    });

    expect(out.decision).toBe("denied");
    expect(out.decidedBy).toBe("policy:deny-by-default");
    expect(out.value).toBeUndefined();
    expect(approvalEvents).toBe(0);
  });

  it("denies with policy:cannot_access_secrets when explicitly blocked", async () => {
    store.add("openai-key", "sk-xyz");
    const { mediator, policy } = buildMediator(db, bus, store);
    policy.loadYamlText(`
agents:
  hermes:
    cannot_access_secrets:
      - openai-key
`);
    const out = await mediator.handleSecretGet({
      sourceAgent: "hermes",
      secretName: "openai-key",
    });
    expect(out.decision).toBe("denied");
    expect(out.decidedBy).toBe("policy:cannot_access_secrets");
  });

  it("returns the value when policy grants access + emits request:decided", async () => {
    store.add("anthropic-key", "sk-allowed");
    const { mediator, policy } = buildMediator(db, bus, store);
    policy.loadYamlText(`
agents:
  hermes:
    can_access_secrets:
      - anthropic-key
`);
    const events: unknown[] = [];
    bus.on("request:decided", (e) => events.push(e));

    const out = await mediator.handleSecretGet({
      sourceAgent: "hermes",
      secretName: "anthropic-key",
    });

    expect(out.decision).toBe("allowed");
    expect(out.value).toBe("sk-allowed");
    expect(events).toHaveLength(1);
    const e = events[0] as {
      targetAgent: string;
      targetTool: string;
      sourceAgent: string;
      decision: string;
      args: { name: string };
    };
    expect(e.targetAgent).toBe("foreman");
    expect(e.targetTool).toBe("secrets/get");
    expect(e.decision).toBe("allowed");
    expect(e.args.name).toBe("anthropic-key");
  });

  it("returns denied with secret-store:not-found when policy allows but the secret is missing", async () => {
    const { mediator, policy } = buildMediator(db, bus, store);
    policy.loadYamlText(`
agents:
  hermes:
    can_access_secrets:
      - phantom-key
`);
    const out = await mediator.handleSecretGet({
      sourceAgent: "hermes",
      secretName: "phantom-key",
    });
    expect(out.decision).toBe("denied");
    expect(out.decidedBy).toBe("secret-store:not-found");
  });
});
