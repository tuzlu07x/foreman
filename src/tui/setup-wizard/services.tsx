import { ConfirmInput, MultiSelect, PasswordInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import type { JSX } from "react";
import { WizardProgress } from "../components/wizard-progress.js";
import { osc8 } from "../osc8.js";
import { persistVoiceConfig } from "../setup-wizard-voice-persist.js";
import { theme } from "../theme.js";
import type { WizardContext } from "./context.js";
import { stepProgress } from "./progress.js";
import {
  applyServicesPickerSubmit,
  applyServiceValueSubmit,
  buildServicePromptList,
  consumingAgentsFor,
  persistNotifyConfigFromWizardState,
} from "./services-logic.js";

// Step 4 — Services: picker → per-secret value prompts → summary.
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
  } = ctx.state;
  const {
    setServicesSelected,
    setServiceIdx,
    setServicesPhase,
    setServicesSaved,
    setServicesSkipped,
    setServicesWarning,
  } = ctx.set;
// ---------------- Services — picker ----------------
if (servicesPhase === "picker") {
  const options = serviceCatalog.map((s) => {
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
        ↑↓ move · <Text bold>Space toggle</Text> · Enter confirm. 3rd-party
        tokens (Telegram, Discord, Slack, GitHub, …). Each one stores its
        token encrypted on disk and gets handed to consuming agents on
        demand. Skippable — leave empty + Enter to bypass.
      </Text>
      <MultiSelect
        options={options}
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
  const headerLabel =
    prompt.kind === "extra"
      ? `${service.name} — ${prompt.secretName}`
      : service.name;
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
        (Enter to save · Enter on empty input to skip)
      </Text>
      {servicesWarning && (
        <Text color={theme.accent.warning}>⚠ {servicesWarning}</Text>
      )}
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
          });
          if (result.shouldSave) {
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
          }
          setServicesWarning(result.warning);
          setServiceIdx(result.nextIdx);
          setServicesPhase(result.nextPhase);
        }}
      />
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
      <Text>Continue to install? (y/n)</Text>
      <ConfirmInput
        onConfirm={() => {
          persistNotifyConfigFromWizardState(services, serviceCatalog, servicesSaved);
          // #305 — seed voice.yaml alongside notify.yaml so ForemanVoice
          // + pattern detection have a config to read on first boot.
          persistVoiceConfig(services.voiceConfigPath, servicesSaved);
          advance("services");
        }}
        onCancel={() => {
          persistNotifyConfigFromWizardState(services, serviceCatalog, servicesSaved);
          persistVoiceConfig(services.voiceConfigPath, servicesSaved);
          advance("services");
        }}
      />
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
  } = ctx.set;
  if (currentStep === "services") {
    if (servicesPhase === "values" || servicesPhase === "summary") {
      setServicesPhase("picker");
      setServiceIdx(0);
      setServicesWarning(null);
      return true;
    }
    // picker → agents confirm (the most recent agents phase)
    uncomplete("agents");
    setAgentsPhase("confirm");
    return true;
  }
  return false;
}
