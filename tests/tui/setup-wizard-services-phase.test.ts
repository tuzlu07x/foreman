import { describe, expect, it } from "vitest";
import {
  applyServiceValueSubmit,
  applyServicesPickerSubmit,
  buildServicePromptList,
  consumingAgentsFor,
} from "../../src/tui/setup-wizard.js";
import type { ServiceEntry } from "../../src/core/registry-catalog.js";

function service(overrides: Partial<ServiceEntry>): ServiceEntry {
  return {
    id: "telegram",
    name: "Telegram",
    description: "Bot integration",
    secret_name: "telegram-bot-token",
    where_to_get: "https://t.me/BotFather",
    format_hint: "123456789:ABC...",
    setup_steps: ["Open Telegram", "Talk to BotFather"],
    used_by_agents: ["hermes", "openclaw"],
    open_url_hotkey: true,
    extra_secrets: [],
    ...overrides,
  };
}

describe("applyServicesPickerSubmit", () => {
  it("transitions to summary on empty selection", () => {
    const result = applyServicesPickerSubmit([]);
    expect(result.nextPhase).toBe("summary");
    expect(result.selected).toEqual([]);
  });

  it("transitions to values when one service is selected", () => {
    const result = applyServicesPickerSubmit(["telegram"]);
    expect(result.nextPhase).toBe("values");
    expect(result.selected).toEqual(["telegram"]);
  });

  it("preserves selection order across multiple picks", () => {
    const result = applyServicesPickerSubmit(["github", "telegram", "slack"]);
    expect(result.selected).toEqual(["github", "telegram", "slack"]);
  });
});

describe("applyServiceValueSubmit", () => {
  it("saves the value and advances when more services remain", () => {
    const result = applyServiceValueSubmit({
      serviceId: "telegram",
      value: "123:abc",
      currentIdx: 0,
      totalSelected: 2,
    });
    expect(result.shouldSave).toBe(true);
    expect(result.warning).toBeNull();
    expect(result.nextPhase).toBe("values");
    expect(result.nextIdx).toBe(1);
  });

  it("transitions to summary on the last service", () => {
    const result = applyServiceValueSubmit({
      serviceId: "github",
      value: "ghp_xxx",
      currentIdx: 1,
      totalSelected: 2,
    });
    expect(result.shouldSave).toBe(true);
    expect(result.nextPhase).toBe("summary");
    expect(result.nextIdx).toBe(2);
  });

  it("skips empty values with a warning mid-loop", () => {
    const result = applyServiceValueSubmit({
      serviceId: "telegram",
      value: "",
      currentIdx: 0,
      totalSelected: 3,
    });
    expect(result.shouldSave).toBe(false);
    expect(result.warning).toContain("Skipped telegram");
    expect(result.nextPhase).toBe("values");
    expect(result.nextIdx).toBe(1);
  });

  it("skip on the last service still transitions to summary", () => {
    const result = applyServiceValueSubmit({
      serviceId: "github",
      value: "",
      currentIdx: 2,
      totalSelected: 3,
    });
    expect(result.shouldSave).toBe(false);
    expect(result.nextPhase).toBe("summary");
    expect(result.nextIdx).toBe(3);
  });

  it("single-service selection (idx 0 of 1) goes summary on save", () => {
    const result = applyServiceValueSubmit({
      serviceId: "telegram",
      value: "x",
      currentIdx: 0,
      totalSelected: 1,
    });
    expect(result.shouldSave).toBe(true);
    expect(result.nextPhase).toBe("summary");
    expect(result.nextIdx).toBe(1);
  });
});

describe("buildServicePromptList (#220)", () => {
  it("emits one prompt per service when there are no extras", () => {
    const list = buildServicePromptList(
      ["telegram"],
      [service({ extra_secrets: [] })],
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      serviceId: "telegram",
      secretName: "telegram-bot-token",
      kind: "primary",
    });
  });

  it("emits primary + one prompt per extra_secret in declaration order", () => {
    const telegram = service({
      extra_secrets: [
        {
          name: "telegram-chat-id",
          format_hint: "-1001234567890",
          setup_steps: ["s1"],
          optional: true,
        },
      ],
    });
    const list = buildServicePromptList(["telegram"], [telegram]);
    expect(list.map((p) => `${p.serviceId}:${p.secretName}:${p.kind}`)).toEqual([
      "telegram:telegram-bot-token:primary",
      "telegram:telegram-chat-id:extra",
    ]);
  });

  it("handles a mix of services with and without extras", () => {
    const telegram = service({
      extra_secrets: [
        {
          name: "telegram-chat-id",
          format_hint: "x",
          setup_steps: ["s"],
          optional: true,
        },
      ],
    });
    const github = service({
      id: "github",
      name: "GitHub",
      secret_name: "github-pat",
      extra_secrets: [],
    });
    const list = buildServicePromptList(["github", "telegram"], [github, telegram]);
    expect(list.map((p) => p.secretName)).toEqual([
      "github-pat",
      "telegram-bot-token",
      "telegram-chat-id",
    ]);
  });

  it("silently drops service ids that aren't in the catalog (defensive)", () => {
    const list = buildServicePromptList(
      ["nope", "telegram"],
      [service({ extra_secrets: [] })],
    );
    expect(list).toHaveLength(1);
    expect(list[0]!.serviceId).toBe("telegram");
  });

  it("extra prompts carry the extra's where_to_get + setup_steps + optional", () => {
    const telegram = service({
      extra_secrets: [
        {
          name: "telegram-chat-id",
          format_hint: "-1001234567890",
          where_to_get: null,
          setup_steps: ["Open Telegram", "Get chat.id"],
          optional: true,
        },
      ],
    });
    const list = buildServicePromptList(["telegram"], [telegram]);
    const extra = list[1]!;
    expect(extra.whereToGet).toBeNull();
    expect(extra.setupSteps).toEqual(["Open Telegram", "Get chat.id"]);
    expect(extra.optional).toBe(true);
  });
});

describe("consumingAgentsFor", () => {
  it("returns the intersection of used_by_agents and agentsSelected", () => {
    const s = service({ used_by_agents: ["hermes", "openclaw", "claude-code"] });
    expect(consumingAgentsFor(s, ["hermes", "claude-code"])).toEqual([
      "hermes",
      "claude-code",
    ]);
  });

  it("returns empty when no overlap (user didn't pick any consuming agent)", () => {
    const s = service({ used_by_agents: ["hermes"] });
    expect(consumingAgentsFor(s, ["claude-code", "codex"])).toEqual([]);
  });

  it("returns empty when service has no listed consumers", () => {
    const s = service({ used_by_agents: [] });
    expect(consumingAgentsFor(s, ["hermes"])).toEqual([]);
  });

  it("preserves the order from used_by_agents (not agentsSelected)", () => {
    const s = service({ used_by_agents: ["openclaw", "hermes"] });
    expect(consumingAgentsFor(s, ["hermes", "openclaw"])).toEqual([
      "openclaw",
      "hermes",
    ]);
  });
});
