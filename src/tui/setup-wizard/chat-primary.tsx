import { Box, Text } from "ink";
import type { Key } from "ink";
import { type JSX, useEffect, useMemo } from "react";
import type { AgentEntry } from "../../core/registry-catalog.js";
import { WizardProgress } from "../components/wizard-progress.js";
import { theme } from "../theme.js";
import type { WizardContext } from "./context.js";
import { backToIntegrations } from "./integrations.js";
import { stepProgress } from "./progress.js";
import type { WizardState } from "./state.js";

export interface ChatPrimaryChannel {
  channel: string;
  candidates: AgentEntry[];
}

// #426 — Primary chat agent picker state. `chatPrimaryChannelsNeeded`
// lists messaging channels (telegram/discord/slack) where 2+ selected
// chat_capable agents both support the same channel — those are the
// collisions the wizard must resolve. Empty → step auto-skipped.
export function useChatPrimaryChannelsNeeded(
  args: Pick<WizardContext, "agentCatalog"> &
    Pick<WizardState, "servicesSelected" | "agentsSelected">,
): ChatPrimaryChannel[] {
  const { servicesSelected, agentsSelected, agentCatalog } = args;
  return useMemo<
    Array<{ channel: string; candidates: AgentEntry[] }>
  >(() => {
    const messagingChannels = ["telegram", "discord", "slack"];
    const out: Array<{ channel: string; candidates: AgentEntry[] }> = [];
    for (const ch of messagingChannels) {
      if (!servicesSelected.includes(ch)) continue;
      const cands = agentCatalog.filter(
        (a) =>
          agentsSelected.includes(a.id) &&
          a.chat_capable === true &&
          (a.optional_services ?? []).includes(ch),
      );
      if (cands.length >= 2) out.push({ channel: ch, candidates: cands });
    }
    return out;
  }, [servicesSelected, agentsSelected, agentCatalog]);
}

export function useChatPrimaryAutoAdvance(ctx: WizardContext): void {
  const { currentStep, advance, chatPrimaryChannelsNeeded } = ctx;
  // Auto-advance past chat-primary when there's no collision to resolve
  // (zero or one chat_capable agent, or no messaging channel). Without
  // this, the wizard would land on a blank picker.
  useEffect(() => {
    if (
      currentStep === "chat-primary" &&
      chatPrimaryChannelsNeeded.length === 0
    ) {
      advance("chat-primary");
    }
  }, [currentStep, chatPrimaryChannelsNeeded.length]);
}

// #426 — Primary chat agent picker.
export function handleChatPrimaryInput(
  ctx: WizardContext,
  input: string,
  key: Key,
): boolean {
  const {
    services,
    currentStep,
    advance,
    chatPrimaryChannelsNeeded,
  } = ctx;
  const {
    chatPrimaryChannelIdx,
    chatPrimaryCursor,
    chatPrimaryDrafts,
  } = ctx.state;
  const {
    setChatPrimaryChannelIdx,
    setChatPrimaryCursor,
    setChatPrimaryDrafts,
  } = ctx.set;
  if (currentStep === "chat-primary") {
    const ch = chatPrimaryChannelsNeeded[chatPrimaryChannelIdx];
    if (!ch) return true;
    if (key.upArrow) {
      setChatPrimaryCursor(
        (c) => (c - 1 + ch.candidates.length) % ch.candidates.length,
      );
      return true;
    }
    if (key.downArrow) {
      setChatPrimaryCursor((c) => (c + 1) % ch.candidates.length);
      return true;
    }
    if (key.return || input === " ") {
      const picked = ch.candidates[chatPrimaryCursor];
      if (!picked) return true;
      const nextDrafts = {
        ...chatPrimaryDrafts,
        [ch.channel]: picked.id,
      };
      setChatPrimaryDrafts(nextDrafts);
      if (chatPrimaryChannelIdx + 1 < chatPrimaryChannelsNeeded.length) {
        setChatPrimaryChannelIdx((i) => i + 1);
        setChatPrimaryCursor(0);
        return true;
      }
      // Last channel — persist all picks and advance.
      if (services.chatPrimary) {
        for (const [channel, agentId] of Object.entries(nextDrafts)) {
          services.chatPrimary.set(channel, agentId);
        }
      }
      advance("chat-primary");
      return true;
    }
    if (key.escape) {
      if (chatPrimaryChannelIdx > 0) {
        setChatPrimaryChannelIdx((i) => i - 1);
        setChatPrimaryCursor(0);
        return true;
      }
      backToIntegrations(ctx);
      return true;
    }
    return true;
  }
  return false;
}

// ---------------- Primary chat agent (#426) ----------------
// Only renders when 2+ chat_capable selected agents share a messaging
// channel; otherwise the useEffect above advance()s past this step.
export function renderChatPrimaryStep(ctx: WizardContext): JSX.Element {
  const { chatPrimaryChannelsNeeded } = ctx;
  const { chatPrimaryChannelIdx, chatPrimaryCursor } = ctx.state;
  const ch = chatPrimaryChannelsNeeded[chatPrimaryChannelIdx];
  if (!ch) {
    return <Text color={theme.fg.muted}>…</Text>;
  }
  const channelLabel =
    ch.channel.charAt(0).toUpperCase() + ch.channel.slice(1);
  return (
    <Box flexDirection="column" gap={1} paddingY={1}>
      <WizardProgress
        {...stepProgress("chat-primary")}
        label={`Primary ${channelLabel} agent`}
        phase={`${chatPrimaryChannelIdx + 1} of ${chatPrimaryChannelsNeeded.length}`}
      />
      <Text color={theme.fg.muted}>
        {ch.candidates.length} of your selected agents can talk on{" "}
        {channelLabel}. Only one can hold the bot session at a time —
        pick which one is your default. The others stay installed but
        won't receive {channelLabel} secrets until you switch them in
        (Settings → Chat Primary, or `foreman chat set-primary`).
      </Text>
      <Box flexDirection="column">
        {ch.candidates.map((agent, idx) => {
          const focused = idx === chatPrimaryCursor;
          return (
            <Box key={agent.id} flexDirection="row">
              <Text
                color={focused ? theme.accent.primary : undefined}
                bold={focused}
              >
                {focused ? "❯ " : "  "}
              </Text>
              <Text bold={focused}>{agent.name}</Text>
              <Text color={theme.fg.muted}>
                {"  "}·  {agent.id}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Text color={theme.fg.muted}>
        [↑↓] move · [Enter] confirm · [Esc] back
      </Text>
    </Box>
  );
}
