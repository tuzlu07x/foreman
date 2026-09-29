import { describe, expect, it } from "vitest";
import {
  applyServiceValueSubmit,
  applyServicesPickerSubmit,
  buildServicePromptList,
  consumingAgentsFor,
} from "../../src/tui/setup-wizard.js";
import type { ServiceEntry } from "../../src/core/registry-catalog.js";
import {
  applyServiceChannelSubmit,
  channelPromptDefault,
  nextIdxAfterSkippedToken,
  servicesPreChecked,
} from "../../src/tui/setup-wizard/services-logic.js";

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

// QA #657 L8 — a resumed setup starts with nothing saved this run.
describe('services step on a resumed setup', () => {
  it('keeps a stored secret on empty input instead of calling it skipped', () => {
    const r = applyServiceValueSubmit({ serviceId: 'telegram-bot-token', value: '', currentIdx: 0, totalSelected: 2, alreadyStored: true })
    expect(r).toMatchObject({ shouldSave: false, keepStored: true, warning: null, nextPhase: 'values', nextIdx: 1 })
  })

  it('pre-checks the session pick and the services already stored', () => {
    const catalog = [
      { id: 'telegram', secret_name: 'telegram-bot-token' },
      { id: 'github', secret_name: 'github-pat' },
      { id: 'slack', secret_name: 'slack-bot-token' },
    ] as never
    const store = { exists: (n: string) => n === 'github-pat' }
    expect(servicesPreChecked(['slack'], catalog, store)).toEqual(['github', 'slack'])
  })
})

// Real-user test: a Discord public key pasted as the bot token was saved
// at once ("… Saved anyway"). A value that fails its paste check now needs
// the same value submitted again.
describe('applyServiceValueSubmit — a value with the wrong shape', () => {
  const base = { serviceId: 'discord-bot-token', currentIdx: 0, totalSelected: 2 }
  const warning = "that doesn't look like a Discord bot token (three dot-separated parts)."

  it('holds it back on the first Enter and stays on the prompt', () => {
    const r = applyServiceValueSubmit({ ...base, value: 'f'.repeat(64), pasteWarning: warning })
    expect(r).toMatchObject({ shouldSave: false, confirm: true, nextPhase: 'values', nextIdx: 0 })
    expect(r.warning).toBe(`${warning} Press Enter again to save it anyway, or paste the right value.`)
  })

  it('saves the same value submitted again, and says how to fix it later', () => {
    const value = 'f'.repeat(64)
    const r = applyServiceValueSubmit({ ...base, value, pasteWarning: warning, pendingValue: value })
    expect(r).toMatchObject({ shouldSave: true, nextPhase: 'values', nextIdx: 1 })
    expect(r.confirm).toBeUndefined()
    expect(r.warning).toContain('Saved anyway — fix it with `foreman secrets rotate discord-bot-token`')
  })

  it('holds back a different wrong value again', () => {
    const r = applyServiceValueSubmit({ ...base, value: 'e'.repeat(64), pasteWarning: warning, pendingValue: 'f'.repeat(64) })
    expect(r).toMatchObject({ shouldSave: false, confirm: true, nextIdx: 0 })
  })

  it('saves a value that passes the check at once', () => {
    const r = applyServiceValueSubmit({ ...base, value: 'good', pasteWarning: null, pendingValue: 'f'.repeat(64) })
    expect(r).toMatchObject({ shouldSave: true, warning: null, nextIdx: 1 })
  })

  it('still skips on empty input while a value is held back', () => {
    const r = applyServiceValueSubmit({ ...base, value: '', pasteWarning: warning, pendingValue: 'f'.repeat(64) })
    expect(r).toMatchObject({ shouldSave: false, nextIdx: 1 })
    expect(r.confirm).toBeUndefined()
    expect(r.warning).toContain('Skipped discord-bot-token')
  })
})

describe('channel prompts for Slack and Discord', () => {
  const slack = service({ id: 'slack', name: 'Slack', secret_name: 'slack-bot-token', extra_secrets: [] })
  const discord = service({ id: 'discord', name: 'Discord', secret_name: 'discord-bot-token', extra_secrets: [] })
  const telegram = service({ extra_secrets: [{ name: 'telegram-chat-id', format_hint: 'x', setup_steps: ['s'], optional: true }] })

  it('asks for the channel right after the bot token', () => {
    const list = buildServicePromptList(['telegram', 'slack', 'discord'], [telegram, slack, discord])
    expect(list.map((p) => `${p.serviceId}:${p.kind}:${p.secretName}`)).toEqual([
      'telegram:primary:telegram-bot-token',
      'telegram:extra:telegram-chat-id',
      'slack:primary:slack-bot-token',
      'slack:channel:slack-channel',
      'discord:primary:discord-bot-token',
      'discord:channel:discord-channel-id',
    ])
    expect(list[3]!.setupSteps.join(' ')).toContain('/invite @yourapp')
    expect(list[5]!.setupSteps.join(' ')).toContain('Copy Channel ID')
    expect(channelPromptDefault('slack')).toBe('#foreman')
    expect(channelPromptDefault('discord')).toBe('')
  })

  it('skips the channel prompt when the bot token was skipped', () => {
    const list = buildServicePromptList(['slack', 'discord'], [slack, discord])
    expect(nextIdxAfterSkippedToken(list, 1, 'slack')).toBe(2)
    expect(nextIdxAfterSkippedToken(list, 3, 'discord')).toBe(4)
    // Nothing to skip after a Telegram token (its chat id prompt stays).
    const tg = buildServicePromptList(['telegram'], [telegram])
    expect(nextIdxAfterSkippedToken(tg, 1, 'telegram')).toBe(1)
  })

  it('accepts a Slack channel name or id, adding the # to a bare name', () => {
    const at = { serviceId: 'slack', currentIdx: 1, totalSelected: 2 }
    expect(applyServiceChannelSubmit({ ...at, value: '#foreman' })).toMatchObject({ target: '#foreman', error: null, nextPhase: 'summary', nextIdx: 2 })
    expect(applyServiceChannelSubmit({ ...at, value: 'alerts' }).target).toBe('#alerts')
    expect(applyServiceChannelSubmit({ ...at, value: 'C0123456789' }).target).toBe('C0123456789')
    expect(applyServiceChannelSubmit({ ...at, value: 'my channel' })).toMatchObject({ target: null, nextIdx: 1, nextPhase: 'values' })
  })

  it('accepts only a 17–20 digit Discord channel id', () => {
    const at = { serviceId: 'discord', currentIdx: 1, totalSelected: 3 }
    expect(applyServiceChannelSubmit({ ...at, value: ' 123456789012345678 ' })).toMatchObject({ target: '123456789012345678', error: null, nextPhase: 'values', nextIdx: 2 })
    for (const bad of ['#general', '1234567890123456', '123456789012345678901', '12345678901234567x']) {
      const r = applyServiceChannelSubmit({ ...at, value: bad })
      expect(r).toMatchObject({ target: null, nextIdx: 1 })
      expect(r.error).toContain('17–20 digits')
    }
  })

  it('skips on empty input and says how to finish later', () => {
    const r = applyServiceChannelSubmit({ serviceId: 'slack', value: '', currentIdx: 1, totalSelected: 2 })
    expect(r).toMatchObject({ target: null, error: null, nextPhase: 'summary', nextIdx: 2 })
    expect(r.warning).toContain("foreman notify enable slack --channel '#foreman'")
    const d = applyServiceChannelSubmit({ serviceId: 'discord', value: '  ', currentIdx: 0, totalSelected: 2 })
    expect(d.warning).toContain('foreman notify enable discord --channel <channel-id>')
  })
})
