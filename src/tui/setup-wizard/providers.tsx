import {
  ConfirmInput,
  MultiSelect,
  PasswordInput,
  TextInput,
} from "@inkjs/ui";
import { Box, Text } from "ink";
import type { JSX } from "react";
import { WizardProgress } from "../components/wizard-progress.js";
import { theme } from "../theme.js";
import type { WizardContext } from "./context.js";
import {
  applyProvidersPickerSubmit,
  buildProviderPromptList,
  handleProviderValueSubmit,
  persistLlmConfigFromWizardState,
  storageNameForPrompt,
} from "./providers-logic.js";
import { isOAuthCapableProvider } from "./shared.js";

// Step 1 — LLM Providers: picker → per-field value prompts → summary.
// Returns null when no providers phase matches (the root then falls
// through to the next step, exactly like the original if-chain).
export function renderProvidersStep(ctx: WizardContext): JSX.Element | null {
  const { services, advance, providerCatalog } = ctx;
  const {
    providerPrompts,
    providerIdx,
    providersPhase,
    providersSaved,
    providersSkipped,
    providersSignedIn,
    authModeAsked,
    providersWarning,
  } = ctx.state;
  const {
    setProvidersSelected,
    setProviderPrompts,
    setProviderIdx,
    setProvidersPhase,
    setProvidersSaved,
    setProvidersSkipped,
    setProvidersSignedIn,
    setAuthModeAsked,
    setProvidersWarning,
  } = ctx.set;
  // ---------------- LLM Providers — picker ----------------
  if (providersPhase === "picker") {
    const options = providerCatalog.map((p) => ({
      value: p.id,
      label: `${p.name} — ${p.description}`,
    }));
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress current={1} total={4} label="LLM Providers" phase="pick which to configure" />
        <Text color={theme.fg.muted}>
          ↑↓ move · <Text bold>Space toggle</Text> · Enter confirm. Pick the
          LLM providers you already have access to. Each one stores its key
          (and endpoint, if applicable) encrypted on disk.
        </Text>
        {/* QA round 6: users repeatedly assumed the OpenAI key pasted
            here would also drive agent LLM calls. It does NOT — these
            keys feed Foreman's own brain (Step 2 — verification,
            summaries). Agents in Step 3 may use the same key OR a
            completely separate auth (OpenRouter, OAuth subscriptions).
            Stating this up front avoids the "I pasted a key, why is
            Hermes still saying auth failed?" rabbit hole. */}
        <Text color={theme.accent.warning}>
          ⓘ Keys here power Foreman's OWN LLM brain (Step 2). Agents
          (Step 3) have their own credentials — Hermes / Claude Code /
          Codex may use OpenRouter, OAuth subscriptions, or these same
          keys depending on the variant you pick later.
        </Text>
        <MultiSelect
          options={options}
          onSubmit={(values) => {
            const result = applyProvidersPickerSubmit(values);
            setProvidersSelected(result.selected);
            setProviderPrompts(
              buildProviderPromptList(providerCatalog, result.selected),
            );
            setProviderIdx(0);
            setProvidersPhase(result.nextPhase);
          }}
        />
        <Text color={theme.fg.muted}>
          [Space] toggle · [Enter] confirm · [Esc] back to welcome
        </Text>
      </Box>
    );
  }

  // ---------------- LLM Providers — value prompts ----------------
  if (providersPhase === "values") {
    const prompt = providerPrompts[providerIdx];
    if (!prompt) {
      setProvidersPhase("summary");
      return <Text>…</Text>;
    }
    const provider = providerCatalog.find((p) => p.id === prompt.providerId);
    if (!provider) {
      setProvidersPhase("summary");
      return <Text>…</Text>;
    }
    // Faz 4b-3 — for OAuth-capable providers (anthropic, openai), offer
    // subscription sign-in ahead of the key paste. Asked once per provider
    // per wizard run (`authModeAsked` debounces); on Y we mark the provider
    // for OAuth + skip the key prompt, on N we fall through to the normal
    // PasswordInput render below.
    if (
      prompt.kind === "key" &&
      isOAuthCapableProvider(prompt.providerId) &&
      !authModeAsked.includes(prompt.providerId)
    ) {
      const providerLabel = provider.name;
      const subscriptionLabel =
        prompt.providerId === "anthropic" ? "Claude" : "ChatGPT";
      const oauthProviderId = prompt.providerId;
      return (
        <Box flexDirection="column" gap={1} paddingY={1}>
          <WizardProgress
            current={1}
            total={4}
            label="LLM Providers"
            phase={`auth mode ${theme.symbols.bullet} ${providerLabel}`}
          />
          <Text>
            {theme.symbols.bullet} How do you want to authenticate to{" "}
            <Text bold color={theme.accent.primary}>
              {providerLabel}
            </Text>
            ?
          </Text>
          <Text color={theme.fg.muted}>
            If you have a {subscriptionLabel} subscription, signing in skips
            the API-key paste — Foreman draws from your plan's rate limits,
            no separate API budget needed.
          </Text>
          <Text>
            Sign in with your {subscriptionLabel} subscription instead of
            pasting a key? (y/n)
          </Text>
          <ConfirmInput
            onConfirm={() => {
              setProvidersSignedIn((prev) =>
                prev.includes(oauthProviderId) ? prev : [...prev, oauthProviderId],
              );
              setAuthModeAsked((prev) =>
                prev.includes(oauthProviderId) ? prev : [...prev, oauthProviderId],
              );
              // Skip the key prompt for this provider; advance.
              if (providerIdx + 1 >= providerPrompts.length) {
                setProvidersPhase("summary");
              } else {
                setProviderIdx(providerIdx + 1);
              }
            }}
            onCancel={() => {
              // Falls through to PasswordInput on next render.
              setAuthModeAsked((prev) =>
                prev.includes(oauthProviderId) ? prev : [...prev, oauthProviderId],
              );
            }}
          />
          <Text color={theme.fg.muted}>
            [y] sign in via `foreman llm login` after wizard
            {" · "}[n] paste an API key now
          </Text>
        </Box>
      );
    }
    const storageName = storageNameForPrompt(prompt, provider);
    const isEndpoint = prompt.kind === "endpoint";
    const progress = `(${providerIdx + 1}/${providerPrompts.length})`;
    const fieldLabel = isEndpoint
      ? `${provider.name} endpoint`
      : `${provider.name} API key`;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          current={1}
          total={4}
          label="LLM Providers"
          phase={`value ${providerIdx + 1} of ${providerPrompts.length} ${theme.symbols.bullet} ${provider.name}`}
        />
        <Text>
          {theme.symbols.bullet} Value for{" "}
          <Text bold color={theme.accent.primary}>
            {fieldLabel}
          </Text>{" "}
          <Text color={theme.fg.muted}>{progress}</Text>
        </Text>
        {provider.where_to_get && (
          <Text color={theme.fg.muted}>
            Get yours at:{" "}
            <Text color={theme.accent.primary}>{provider.where_to_get}</Text>
          </Text>
        )}
        {provider.format_hint && (
          <Text color={theme.fg.muted}>
            Expected format:{" "}
            <Text color={theme.accent.primary}>{provider.format_hint}</Text>
          </Text>
        )}
        {provider.instructions.length > 0 && (
          <Box flexDirection="column">
            {provider.instructions.map((line, i) => (
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
        {providersWarning && (
          <Text color={theme.accent.warning}>⚠ {providersWarning}</Text>
        )}
        {isEndpoint ? (
          // key= forces a fresh mount per prompt so the field never keeps the
          // previous provider's value (#219). Stable id includes the kind so
          // an endpoint+key combo for the same provider also gets two clean mounts.
          <TextInput
            key={`prov:${prompt.providerId}:${prompt.kind}`}
            defaultValue={provider.endpoint_default ?? ""}
            placeholder={provider.endpoint_default ?? "endpoint URL"}
            onSubmit={(value) => {
              handleProviderValueSubmit(
                prompt,
                provider,
                storageName,
                value,
                services,
                providerPrompts.length,
                providerIdx,
                setProvidersSaved,
                setProvidersSkipped,
                setProvidersWarning,
                setProviderIdx,
                setProvidersPhase,
              );
            }}
          />
        ) : (
          <PasswordInput
            key={`prov:${prompt.providerId}:${prompt.kind}`}
            placeholder="…"
            onSubmit={(value) => {
              handleProviderValueSubmit(
                prompt,
                provider,
                storageName,
                value,
                services,
                providerPrompts.length,
                providerIdx,
                setProvidersSaved,
                setProvidersSkipped,
                setProvidersWarning,
                setProviderIdx,
                setProvidersPhase,
              );
            }}
          />
        )}
        <Text color={theme.fg.muted}>
          [Enter] save · [Esc] back to selection
        </Text>
      </Box>
    );
  }

  // ---------------- LLM Providers — summary ----------------
  if (providersPhase === "summary") {
    const savedCount = providersSaved.length;
    const skippedCount = providersSkipped.length;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress current={1} total={4} label="LLM Providers" phase="summary" />
        {savedCount > 0 ? (
          <Box flexDirection="column">
            <Text color={theme.accent.success}>
              ✓ Saved {savedCount} provider value
              {savedCount === 1 ? "" : "s"}:
            </Text>
            {providersSaved.map((name, idx) => (
              // #341 — compound key so a re-saved name (user backed out + re-
              // entered the same prompt) doesn't collide with itself.
              <Text key={`${name}:${idx}`} color={theme.fg.muted}>
                {"  "}• {name}
              </Text>
            ))}
          </Box>
        ) : (
          <Text color={theme.fg.muted}>
            (no providers configured — you can add them later from the LLM
            Providers page)
          </Text>
        )}
        {providersSignedIn.length > 0 && (
          <Box flexDirection="column">
            <Text color={theme.accent.primary}>
              ⚿ Will sign in via subscription (post-wizard):
            </Text>
            {providersSignedIn.map((id) => (
              <Text key={`signin:${id}`} color={theme.fg.muted}>
                {"  "}• {id} — runs `foreman llm login {id}`
              </Text>
            ))}
          </Box>
        )}
        {skippedCount > 0 && (
          <Box flexDirection="column">
            <Text color={theme.accent.warning}>
              ⚠ Skipped {skippedCount} (empty value):
            </Text>
            {providersSkipped.map((name, idx) => (
              <Text key={`${name}:${idx}`} color={theme.fg.muted}>
                {"  "}• {name}
              </Text>
            ))}
          </Box>
        )}
        <Text>Continue to agents? (y/n)</Text>
        <ConfirmInput
          onConfirm={() => {
            persistLlmConfigFromWizardState(
              services,
              providerCatalog,
              providersSaved,
              providersSignedIn,
            );
            advance("providers");
          }}
          onCancel={() => {
            persistLlmConfigFromWizardState(
              services,
              providerCatalog,
              providersSaved,
              providersSignedIn,
            );
            advance("providers");
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

// Esc back-navigation for the providers step (#153).
export function handleProvidersEscape(ctx: WizardContext): boolean {
  const { currentStep, uncomplete } = ctx;
  const { providersPhase } = ctx.state;
  const { setProviderIdx, setProvidersPhase, setProvidersWarning } = ctx.set;
  if (currentStep === "providers") {
    if (providersPhase === "values" || providersPhase === "summary") {
      setProvidersPhase("picker");
      setProviderIdx(0);
      setProvidersWarning(null);
      return true;
    }
    uncomplete("welcome");
    return true;
  }
  return false;
}
