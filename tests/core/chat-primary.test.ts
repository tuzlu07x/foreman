import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatPrimaryService } from "../../src/core/chat-primary.js";
import {
  EventBus,
  type ForemanEventMap,
} from "../../src/core/event-bus.js";
import { createInMemoryDb, type ForemanDb } from "../../src/db/client.js";

describe("ChatPrimaryService (#426)", () => {
  let db: ForemanDb;
  let sqlite: Database.Database;
  let bus: EventBus<ForemanEventMap>;
  let svc: ChatPrimaryService;

  beforeEach(() => {
    const handle = createInMemoryDb();
    db = handle.db;
    sqlite = handle.sqlite;
    bus = new EventBus<ForemanEventMap>();
    svc = new ChatPrimaryService(db, { bus });
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("get / list", () => {
    it("returns null + empty list when no primary is set", () => {
      expect(svc.get("telegram")).toBeNull();
      expect(svc.list()).toEqual([]);
    });
  });

  describe("set", () => {
    it("creates the row + emits chat-primary:changed with previousAgentId=null", () => {
      const events: ForemanEventMap["chat-primary:changed"][] = [];
      bus.on("chat-primary:changed", (p) => events.push(p));

      svc.set("telegram", "hermes");

      expect(svc.get("telegram")).toMatchObject({
        channel: "telegram",
        agentId: "hermes",
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        channel: "telegram",
        agentId: "hermes",
        previousAgentId: null,
      });
    });

    it("overwrites + reports the previous agentId on re-set", () => {
      svc.set("telegram", "hermes");
      const events: ForemanEventMap["chat-primary:changed"][] = [];
      bus.on("chat-primary:changed", (p) => events.push(p));

      svc.set("telegram", "openclaw");

      expect(svc.get("telegram")?.agentId).toBe("openclaw");
      expect(events[0]?.previousAgentId).toBe("hermes");
      expect(events[0]?.agentId).toBe("openclaw");
    });

    it("scopes per channel — setting telegram doesn't touch discord", () => {
      svc.set("telegram", "hermes");
      svc.set("discord", "openclaw");

      expect(svc.get("telegram")?.agentId).toBe("hermes");
      expect(svc.get("discord")?.agentId).toBe("openclaw");
      expect(svc.list()).toHaveLength(2);
    });
  });

  describe("unset", () => {
    it("removes the row + emits agentId=null with previousAgentId set", () => {
      svc.set("telegram", "hermes");
      const events: ForemanEventMap["chat-primary:changed"][] = [];
      bus.on("chat-primary:changed", (p) => events.push(p));

      svc.unset("telegram");

      expect(svc.get("telegram")).toBeNull();
      expect(events[0]).toMatchObject({
        channel: "telegram",
        agentId: null,
        previousAgentId: "hermes",
      });
    });

    it("is a no-op when nothing is set — emits nothing", () => {
      const events: ForemanEventMap["chat-primary:changed"][] = [];
      bus.on("chat-primary:changed", (p) => events.push(p));

      svc.unset("telegram");

      expect(events).toEqual([]);
    });
  });

  describe("isPrimary (projector gate)", () => {
    it("returns true for every agent when no primary is set (legacy compat)", () => {
      expect(svc.isPrimary("telegram", "hermes")).toBe(true);
      expect(svc.isPrimary("telegram", "openclaw")).toBe(true);
    });

    it("returns true only for the configured primary once set", () => {
      svc.set("telegram", "hermes");
      expect(svc.isPrimary("telegram", "hermes")).toBe(true);
      expect(svc.isPrimary("telegram", "openclaw")).toBe(false);
    });

    it("does not bleed across channels — telegram primary doesn't gate discord", () => {
      svc.set("telegram", "hermes");
      expect(svc.isPrimary("discord", "openclaw")).toBe(true);
    });
  });
});
