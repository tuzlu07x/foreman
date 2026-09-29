import { ConfirmInput, MultiSelect, PasswordInput, TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import type { JSX } from "react";
import { WizardProgress } from "../components/wizard-progress.js";
import { osc8 } from "../osc8.js";
import type { ChannelTargets } from "../setup-wizard-notify-persist.js";
import { persistVoiceConfig } from "../setup-wizard-voice-persist.js";
import { theme } from "../theme.js";
import type { WizardContext } from "./context.js";
import { servicePasteWarning } from "./paste-checks.js";
import { stepProgress } from "./progress.js";
import {
  applyServiceChannelSubmit,
  applyServicesPickerSubmit,
  applyServiceValueSubmit,
  buildServicePromptList,
  channelPromptDefault,
  consumingAgentsFor,
  nextIdxAfterSkippedToken,
  notifyChannelsToFinish,
  notifyWiringNames,
  persistNotifyConfigFromWizardState,
  servicesPreChecked,
  wizardServiceChoices,
} from "./services-logic.js";

// Step 4 — Services (chat apps): picker → per-secret value prompts → summary.
// Returns null when no services phase matches (root falls through).
export function renderServicesStep(ctx: WizardContext): JSX.Element | null {
  const { services, advance, serviceCatalog } = ctx;
  const {
    agentsSelected,
    servicesSelected,
    serviceIdx,
    servicesPhase,
    servicesSaved,
    servicesSkipped,
    servicesWarning,
    servicesPendingPaste,
    servicesChannelTargets,
  } = ctx.state;
  const {
    setServicesSelected,
    setServiceIdx,
    setServicesPhase,
    setServicesSaved,
    setServicesSkipped,
    setServicesWarning,
    setServicesPendingPaste,
    setServicesChannelTargets,
  } = ctx.set;
  // Only Slack and Discord bots take a channel.
  const channelTargets: ChannelTargets = {
    ...(servicesChannelTargets.slack ? { slack: servicesChannelTargets.slack } : {}),
    ...(servicesChannelTargets.discord ? { discord: servicesChannelTargets.discord } : {}),
  };
// ---------------- Services — picker ----------------
if (servicesPhase === "picker") {
  const choices = wizardServiceChoices(serviceCatalog);
  const options = choices.map((s) => {
    const consumers = consumingAgentsFor(s, agentsSelected);
    const usedBy =
      consumers.length > 0
        ? `Used by: ${consumers.join(", ")}`
        : "(no installed agents use this — you can add it anyway)";
    return {
      value: s.id,
      label: `${s.name} — ${usedBy}`,
    };
  });
  return (
    <Box flexDirection="column" gap={1} paddingY={1}>
      <WizardProgress {...stepProgress("services")} label="Services" phase="pick which to configure" />
      <Text color={theme.fg.muted}>
        ↑↓ move · <Text bold>Space toggle</Text> · Enter confirm. Chat
        apps (Telegram, Discord, Slack). Each one stores its token
        encrypted on disk and gets handed to consuming agents on demand.
        GitHub, Jira and Notion are in the next step (Integrations).
        Skippable — leave empty + Enter to bypass.
      </Text>
      <MultiSelect
        options={options}
        defaultValue={servicesPreChecked(servicesSelected, choices, services.secretStore)}
        onSubmit={(values) => {
          const result = applyServicesPickerSubmit(values);
          setServicesSelected(result.selected);
          setServiceIdx(0);
          setServicesPhase(result.nextPhase);
        }}
      />
      <Text color={theme.fg.muted}>
        [Space] toggle · [Enter] continue · [Esc] back to agents
      </Text>
    </Box>
  );
}

// ---------------- Services — value prompts ----------------
if (servicesPhase === "values") {
  // Flatten selected services → one prompt per (primary + each extra
  // secret). Telegram emits two prompts: bot token, then chat id (#220).
  const servicePrompts = buildServicePromptList(
    servicesSelected,
    serviceCatalog,
  );
  const prompt = servicePrompts[serviceIdx];
  if (!prompt) {
    setServicesPhase("summary");
    return <Text>…</Text>;
  }
  const service = serviceCatalog.find((s) => s.id === prompt.serviceId);
  if (!service) {
    setServicesPhase("summary");
    return <Text>…</Text>;
  }
  const progress = `(${serviceIdx + 1}/${servicePrompts.length})`;
  const isChannel = prompt.kind === "channel";
  const alreadyStored = !isChannel && services.secretStore.exists(prompt.secretName);
  const headerLabel =
    prompt.kind === "extra"
      ? `${service.name} — ${prompt.secretName}`
      : isChannel
        ? `${service.name} — ${prompt.label}`
        : service.name;
  const channelDefault = channelPromptDefault(prompt.serviceId);
  return (
    <Box flexDirection="column" gap={1} paddingY={1}>
      <WizardProgress
        {...stepProgress("services")}
        label="Services"
        phase={`prompt ${serviceIdx + 1} of ${servicePrompts.length} ${theme.symbols.bullet} ${headerLabel}`}
      />
      <Text>
        {theme.symbols.bullet} Setting up{" "}
        <Text bold color={theme.accent.primary}>
          {headerLabel}
        </Text>{" "}
        <Text color={theme.fg.muted}>{progress}</Text>
      </Text>
      {prompt.whereToGet ? (
        <Text color={theme.fg.muted}>
          Get yours at:{" "}
          <Text color={theme.accent.primary}>
            {service.open_url_hotkey
              ? osc8(prompt.whereToGet)
              : prompt.whereToGet}
          </Text>
        </Text>
      ) : null}
      <Text color={theme.fg.muted}>
        Expected format:{" "}
        <Text color={theme.accent.primary}>{prompt.formatHint}</Text>
      </Text>
      {prompt.setupSteps.length > 0 && (
        <Box flexDirection="column">
          {prompt.setupSteps.map((line, i) => (
            <Text key={i} color={theme.fg.muted}>
              {"  "}
              {i + 1}. {line}
            </Text>
          ))}
        </Box>
      )}
      <Text color={theme.fg.muted}>
        {isChannel
          ? channelDefault
            ? `(Enter keeps ${channelDefault} · clear it and press Enter to skip; ${service.name} then stays off)`
            : `(Enter to save · Enter on empty input to skip; ${service.name} then stays off)`
          : alreadyStored
            ? "(already stored — Enter on empty input keeps it · type a new value to replace it)"
            : "(Enter to save · Enter on empty input to skip)"}
      </Text>
      {servicesWarning && (
        <Text color={theme.accent.warning}>⚠ {servicesWarning}</Text>
      )}
      {isChannel ? (
        <TextInput
          key={`service:${prompt.secretName}`}
          defaultValue={channelDefault}
          onSubmit={(value) => {
            const result = applyServiceChannelSubmit({
              serviceId: prompt.serviceId,
              value,
              currentIdx: serviceIdx,
              totalSelected: servicePrompts.length,
            });
            if (result.error) {
              setServicesWarning(result.error);
              return;
            }
            const target = result.target;
            setServicesChannelTargets((prev) => {
              const next = { ...prev };
              if (target) next[prompt.serviceId] = target;
              else delete next[prompt.serviceId];
              return next;
            });
            if (!target) {
              setServicesSkipped((prev) =>
                prev.includes(prompt.secretName) ? prev : [...prev, prompt.secretName],
              );
            }
            setServicesWarning(result.warning);
            setServiceIdx(result.nextIdx);
            setServicesPhase(result.nextPhase);
          }}
        />
      ) : (
        <PasswordInput
          // Remount per secret so the previous token doesn't bleed into the next prompt (#219).
          key={`service:${prompt.secretName}`}
          placeholder="…"
          onSubmit={(value) => {
            const result = applyServiceValueSubmit({
              serviceId: prompt.secretName,
              value,
              currentIdx: serviceIdx,
              totalSelected: servicePrompts.length,
              alreadyStored,
              pasteWarning: servicePasteWarning(prompt.secretName, value),
              pendingValue:
                servicesPendingPaste?.secretName === prompt.secretName
                  ? servicesPendingPaste.value
                  : null,
            });
            if (result.confirm) {
              // Held back: nothing stored until the same value comes again.
              setServicesPendingPaste({ secretName: prompt.secretName, value });
              setServicesWarning(result.warning);
              return;
            }
            setServicesPendingPaste(null);
            let nextIdx = result.nextIdx;
            if (result.keepStored) {
              setServicesSaved((prev) =>
                prev.includes(prompt.secretName) ? prev : [...prev, prompt.secretName],
              );
            } else if (result.shouldSave) {
              try {
                if (!services.secretStore.exists(prompt.secretName)) {
                  services.secretStore.add(prompt.secretName, value);
                } else {
                  services.secretStore.rotate(prompt.secretName, value);
                }
                // #341 — dedupe so re-save doesn't double the entry +
                // collide as a React key in the services summary render.
                setServicesSaved((prev) =>
                  prev.includes(prompt.secretName)
                    ? prev
                    : [...prev, prompt.secretName],
                );
              } catch (err) {
                setServicesWarning(
                  `failed to store ${prompt.secretName}: ${err instanceof Error ? err.message : String(err)}`,
                );
                return;
              }
            } else {
              setServicesSkipped((prev) =>
                prev.includes(prompt.secretName)
                  ? prev
                  : [...prev, prompt.secretName],
              );
              // No bot token, so no channel to ask for.
              nextIdx = nextIdxAfterSkippedToken(servicePrompts, nextIdx, prompt.serviceId);
            }
            setServicesWarning(result.warning);
            setServiceIdx(nextIdx);
            setServicesPhase(nextIdx >= servicePrompts.length ? "summary" : result.nextPhase);
          }}
        />
      )}
      <Text color={theme.fg.muted}>
        [Enter] save · [Esc] back to selection
      </Text>
    </Box>
  );
}

// ---------------- Services — summary ----------------
if (servicesPhase === "summary") {
  const savedCount = servicesSaved.length;
  const skippedCount = servicesSkipped.length;
  // #audit-finding-9 — Telegram is the primary delivery channel; if
  // the user picked it but skipped its tokens, agents have no way to
  // reach the user post-install. Flag this loudly so they don't
  // discover the broken flow only when nothing arrives in their chat.
  const telegramSkippedWithoutSave =
    servicesSelected.includes("telegram") &&
    !servicesSaved.some((n) => n.startsWith("telegram-"));
  const wiringNames = notifyWiringNames(
    servicesSelected,
    servicesSaved,
    serviceCatalog,
    services.secretStore,
  );
  // Chat apps with a token but no chat id / channel stay off in notify.yaml
  // (doctor would flag them half-configured): say how to finish each one.
  const toFinish = notifyChannelsToFinish(services, serviceCatalog, wiringNames, channelTargets);
  const persist = (): void => {
    persistNotifyConfigFromWizardState(services, serviceCatalog, wiringNames, channelTargets);
    // #305 — seed voice.yaml alongside notify.yaml so ForemanVoice
    // + pattern detection have a config to read on first boot.
    persistVoiceConfig(services.voiceConfigPath, servicesSaved);
    advance("services");
  };
  return (
    <Box flexDirection="column" gap={1} paddingY={1}>
      <WizardProgress {...stepProgress("services")} label="Services" phase="summary" />
      {savedCount > 0 ? (
        <Box flexDirection="column">
          <Text color={theme.accent.success}>
            ✓ Wired {savedCount} service{savedCount === 1 ? "" : "s"}:
          </Text>
          {servicesSaved.map((name, idx) => (
            // #341 — compound key so a re-saved name doesn't collide.
            <Text key={`${name}:${idx}`} color={theme.fg.muted}>
              {"  "}• {name}
            </Text>
          ))}
        </Box>
      ) : (
        <Text color={theme.fg.muted}>
          (no services configured — you can add them later from the
          Services page)
        </Text>
      )}
      {skippedCount > 0 && (
        <Box flexDirection="column">
          <Text color={theme.accent.warning}>
            ⚠ Skipped {skippedCount} (empty value):
          </Text>
          {servicesSkipped.map((name, idx) => (
            <Text key={`${name}:${idx}`} color={theme.fg.muted}>
              {"  "}• {name}
            </Text>
          ))}
        </Box>
      )}
      {servicesWarning ? (
        <Text color={theme.accent.warning}>⚠ {servicesWarning}</Text>
      ) : null}
      {telegramSkippedWithoutSave ? (
        <Box flexDirection="column">
          <Text color={theme.accent.warning} bold>
            ⚠ Telegram selected but token + chat id are empty
          </Text>
          <Text color={theme.fg.muted}>
            Agents won't be able to deliver replies until you paste
            telegram-bot-token + telegram-chat-id. Hit [Esc] to go
            back, or continue and add them later via:{" "}
            <Text bold>foreman secrets add telegram-bot-token</Text>.
          </Text>
        </Box>
      ) : null}
      {toFinish.length > 0 ? (
        <Box flexDirection="column">
          <Text color={theme.accent.warning}>
            ⚠ Not turned on yet — finish after setup:
          </Text>
          {toFinish.map((c) => (
            <Text key={c.channel} color={theme.fg.muted}>
              {"  "}• {c.channel} (no {c.missing}): <Text bold>{c.finish}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
      <Text>Continue to integrations? (y/n)</Text>
      <ConfirmInput onConfirm={persist} onCancel={persist} />
      <Text color={theme.fg.muted}>
        [y/n] continue · [Esc] back to selection
      </Text>
    </Box>
  );
}
  return null;
}

// Esc back-navigation for the services step (#153).
export function handleServicesEscape(ctx: WizardContext): boolean {
  const { currentStep, uncomplete } = ctx;
  const { servicesPhase } = ctx.state;
  const {
    setAgentsPhase,
    setServiceIdx,
    setServicesPhase,
    setServicesWarning,
    setServicesPendingPaste,
  } = ctx.set;
  if (currentStep === "services") {
    if (servicesPhase === "values" || servicesPhase === "summary") {
      setServicesPhase("picker");
      setServiceIdx(0);
      setServicesWarning(null);
      setServicesPendingPaste(null);
      return true;
    }
    // picker → agents confirm (the most recent agents phase)
    uncomplete("agents");
    setAgentsPhase("confirm");
    return true;
  }
  return false;
}
