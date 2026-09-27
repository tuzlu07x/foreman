import { Box, Text } from "ink";
import type { Key } from "ink";
import { type JSX, useMemo } from "react";
import {
  isRequiredSetupComplete,
  resolveRequiredSetup,
  type RequiredSetupResolution,
  type SecretStatus,
} from "../../core/required-setup.js";
import { openInBrowser } from "../../utils/browser-open.js";
import { WizardProgress } from "../components/wizard-progress.js";
import { theme } from "../theme.js";
import type { WizardContext } from "./context.js";
import type { WizardState } from "./state.js";

// #408 / #411 Phase 3 — required-setup resolution.
// Recomputed on every render so paste/skip actions reflect immediately.
// The aggregator dedupes secrets across agents (one paste prompt
// covers multiple agents sharing the same key slot) and queues OAuth
// flows that the Done screen surfaces as post-install hints.
export function useRequiredSetupResolution(
  args: Pick<WizardContext, "agentCatalog" | "services"> &
    Pick<
      WizardState,
      "agentsSelected" | "agentConfigs" | "requiredSetupOverrides"
    >,
): RequiredSetupResolution {
  const {
    agentCatalog,
    agentsSelected,
    agentConfigs,
    services,
    requiredSetupOverrides,
  } = args;
  return useMemo<RequiredSetupResolution>(() => {
    const selectedEntries = agentCatalog.filter((a) =>
      agentsSelected.includes(a.id),
    );
    const agentProviders: Record<string, string> = {};
    const agentVariants: Record<string, string> = {};
    for (const agent of selectedEntries) {
      const cfg = agentConfigs[agent.id];
      if (cfg?.llmProvider) {
        agentProviders[agent.id] = cfg.llmProvider;
      }
      if (cfg?.providerVariant) {
        agentVariants[agent.id] = cfg.providerVariant;
      }
    }
    return resolveRequiredSetup({
      agents: selectedEntries,
      agentProviders,
      agentVariants,
      secretStore: services.secretStore,
      sessionOverrides: requiredSetupOverrides,
    });
  }, [
    agentCatalog,
    agentsSelected,
    agentConfigs,
    services.secretStore,
    requiredSetupOverrides,
  ]);
}

/** `[s]` only skips a secret nobody has provided. A stored key (`present`)
 *  or one pasted this run (`saved-in-session`) used to flip to "✗ skipped"
 *  even though the value was right there in the store. */
export function canSkipRequiredSecret(status: SecretStatus): boolean {
  return status === "missing";
}

// #408 / #411 Phase 3 — required-setup step key handling.
// Two phases: picker (cursor over secrets+oauth list) + paste (single-line
// input for the focused secret). Aggregator output (`requiredSetupResolution`)
// is recomputed on every keystroke so paste/skip reactions are immediate.
export function handleRequiredSetupInput(
  ctx: WizardContext,
  input: string,
  key: Key,
): boolean {
  const {
    services,
    currentStep,
    advance,
    uncomplete,
    requiredSetupResolution,
    chatPrimaryChannelsNeeded,
  } = ctx;
  const {
    requiredSetupPhase,
    requiredSetupCursor,
    requiredSetupPasteValue,
  } = ctx.state;
  const {
    setRequiredSetupPhase,
    setRequiredSetupCursor,
    setRequiredSetupPasteValue,
    setRequiredSetupOverrides,
    setServicesPhase,
    setChatPrimaryChannelIdx,
    setChatPrimaryCursor,
  } = ctx.set;
  if (currentStep === "required-setup") {
    if (requiredSetupPhase === "paste") {
      if (key.escape) {
        setRequiredSetupPhase("picker");
        setRequiredSetupPasteValue("");
        return true;
      }
      if (key.return) {
        // Save the pasted value into the secret store + flag this slot
        // as saved-in-session so the aggregator stops flagging it.
        const slot =
          requiredSetupResolution.secrets[requiredSetupCursor]?.slotName;
        if (slot && requiredSetupPasteValue.length > 0) {
          try {
            if (services.secretStore.exists(slot)) {
              services.secretStore.rotate(slot, requiredSetupPasteValue);
            } else {
              services.secretStore.add(slot, requiredSetupPasteValue);
            }
          } catch {
            /* secret-store transient errors fall through — user sees
               a missing badge and can retry */
          }
          setRequiredSetupOverrides((prev) => ({
            ...prev,
            [slot]: "saved-in-session",
          }));
        }
        setRequiredSetupPasteValue("");
        setRequiredSetupPhase("picker");
        return true;
      }
      if (key.backspace || key.delete) {
        setRequiredSetupPasteValue((v) => v.slice(0, -1));
        return true;
      }
      if (input && input.length > 0 && !key.ctrl && !key.meta) {
        setRequiredSetupPasteValue((v) => v + input);
      }
      return true;
    }
    // ---- picker phase ----
    if (key.escape) {
      // Step back. If chat-primary had a collision to resolve, that's
      // the single step before us; otherwise jump past it to services
      // (chat-primary's auto-advance effect re-fires immediately).
      if (chatPrimaryChannelsNeeded.length > 0) {
        uncomplete("chat-primary");
        setChatPrimaryChannelIdx(
          Math.max(0, chatPrimaryChannelsNeeded.length - 1),
        );
        setChatPrimaryCursor(0);
        return true;
      }
      uncomplete("services");
      setServicesPhase("summary");
      return true;
    }
    if (key.upArrow) {
      setRequiredSetupCursor((c) =>
        Math.max(0, c - 1),
      );
      return true;
    }
    if (key.downArrow) {
      setRequiredSetupCursor((c) =>
        Math.min(requiredSetupResolution.secrets.length - 1, c + 1),
      );
      return true;
    }
    if (key.return) {
      // If picker has a focused secret in `missing` state → open paste.
      // If everything is resolved → advance to install.
      const cur = requiredSetupResolution.secrets[requiredSetupCursor];
      if (
        cur &&
        (cur.status === "missing" || cur.status === "skipped")
      ) {
        setRequiredSetupPhase("paste");
        return true;
      }
      // No actionable row — try to advance if complete.
      if (isRequiredSetupComplete(requiredSetupResolution)) {
        advance("required-setup");
      }
      return true;
    }
    if (input === "s") {
      // Skip the currently focused secret. Install will still write
      // everything else; the agent that needed this secret will fail
      // at start time with a clear error (TUI crash banner).
      const cur = requiredSetupResolution.secrets[requiredSetupCursor];
      if (cur && canSkipRequiredSecret(cur.status)) {
        setRequiredSetupOverrides((prev) => ({
          ...prev,
          [cur.slotName]: "skipped",
        }));
      }
      return true;
    }
    if (input === "o") {
      // #408 / #413 Phase 5 — open the acquisition URL in the user's
      // default browser. Best-effort: if the platform handler fails,
      // silently no-op (user can still copy-paste from the picker
      // text). React state mirror not needed — the URL is static.
      const acq =
        requiredSetupResolution.secrets[requiredSetupCursor]?.acquisition;
      if (acq?.url) {
        void openInBrowser(acq.url).catch(() => {
          /* swallowed — fall back to manual copy */
        });
      }
      return true;
    }
    if (input === "c") {
      // Continue / install — only fires when nothing is `missing`.
      if (isRequiredSetupComplete(requiredSetupResolution)) {
        advance("required-setup");
      }
      return true;
    }
    return true;
  }
  return false;
}

// ---------------- Required setup (#408 / #411 Phase 3) ----------------
export function renderRequiredSetupStep(ctx: WizardContext): JSX.Element {
  const { requiredSetupResolution } = ctx;
  const {
    autoPickedVariants,
    requiredSetupPhase,
    requiredSetupCursor,
    requiredSetupPasteValue,
  } = ctx.state;
  const res = requiredSetupResolution;
  const totalSecrets = res.secrets.length;
  const totalOauth = res.oauthSteps.length;
  const totalErrors = res.errors.length;
  const complete = isRequiredSetupComplete(res);

  // Paste sub-phase: focused secret gets a single-line input.
  if (requiredSetupPhase === "paste") {
    const cur = res.secrets[requiredSetupCursor];
    const masked =
      requiredSetupPasteValue.length > 0
        ? `${"•".repeat(Math.min(requiredSetupPasteValue.length, 32))}`
        : "";
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <WizardProgress
          current={5}
          total={5}
          label="Required setup"
          phase={`paste ${cur?.slotName ?? "key"}`}
        />
        {cur?.acquisition ? (
          <Box flexDirection="column">
            <Text color={theme.fg.muted}>
              {cur.acquisition.name}
              {cur.acquisition.url
                ? `  ·  Get one: ${cur.acquisition.url}`
                : ""}
            </Text>
            {cur.acquisition.note ? (
              <Text color={theme.fg.muted}>{cur.acquisition.note}</Text>
            ) : null}
          </Box>
        ) : null}
        <Box>
          <Text bold>{cur?.slotName ?? ""}: </Text>
          <Text>{masked}</Text>
          <Text color={theme.fg.muted}>{masked.length === 0 ? "_" : ""}</Text>
        </Box>
        <Text color={theme.fg.muted}>
          [Enter] save · [Esc] cancel · {requiredSetupPasteValue.length} chars
        </Text>
      </Box>
    );
  }

  // Picker sub-phase: aggregated summary + scrollable secrets list.
  return (
    <Box flexDirection="column" gap={1} paddingY={1}>
      <WizardProgress
        current={5}
        total={5}
        label="Required setup"
        phase={complete ? "all set" : "missing keys"}
      />
      <Text color={theme.fg.muted}>
        Foreman analyzed your agent + provider picks. Below is everything
        needed before install can proceed.
      </Text>
      {/* #457 — When the preferred provider variant needs no extra
          credentials (e.g. Codex/oauth), the variant picker auto-skipped
          and we record the choice here so the user sees what was picked
          on their behalf + how to change it later. */}
      {Object.keys(autoPickedVariants).length > 0 ? (
        <Box flexDirection="column">
          <Text bold>Auto-picked variants ({Object.keys(autoPickedVariants).length})</Text>
          {Object.entries(autoPickedVariants).map(([agentId, info]) => (
            <Box key={agentId} flexDirection="column">
              <Text color={theme.accent.primary}>
                {"  "}✓ {agentId}: {info.label}
              </Text>
              <Text color={theme.fg.muted}>
                {`     change later: foreman provider switch ${agentId} <provider> --variant <id>`}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}
      {totalErrors > 0 ? (
        <Box flexDirection="column">
          <Text color={theme.accent.warning} bold>
            ⚠ Resolver errors ({totalErrors}) — go back to fix
          </Text>
          {res.errors.map((e) => (
            <Text key={`${e.agentId}-${e.foremanProvider}`} color={theme.accent.warning}>
              {"  "}• {e.agentId} / {e.foremanProvider}: {e.error}
            </Text>
          ))}
        </Box>
      ) : null}
      {totalSecrets > 0 ? (
        <Box flexDirection="column">
          <Text bold>
            Required secrets ({totalSecrets})
          </Text>
          {res.secrets.map((s, idx) => {
            const focused = idx === requiredSetupCursor;
            const tag =
              s.status === "present"
                ? "✓"
                : s.status === "saved-in-session"
                  ? "✓"
                  : s.status === "skipped"
                    ? "✗"
                    : "⚠";
            const colour =
              s.status === "missing"
                ? theme.accent.warning
                : s.status === "skipped"
                  ? theme.fg.muted
                  : theme.accent.primary;
            return (
              <Box key={s.slotName} flexDirection="column">
                <Box flexDirection="row">
                  <Text color={focused ? theme.accent.primary : undefined} bold={focused}>
                    {focused ? "❯ " : "  "}
                  </Text>
                  <Text color={colour}>{tag}</Text>
                  <Text> {s.slotName}</Text>
                  <Text color={theme.fg.muted}>
                    {"  "}for: {s.agents.join(", ")} · status: {s.status}
                  </Text>
                </Box>
                {focused && s.acquisition ? (
                  <>
                    <Text color={theme.fg.muted}>
                      {"     "}
                      {s.acquisition.name}
                      {s.acquisition.url
                        ? `  ·  ${s.acquisition.url}`
                        : ""}
                    </Text>
                    {/* #449 — Show the acquisition.note inline so the
                        user understands WHY this secret is being asked
                        for (e.g. "Hermes routes OpenAI calls through
                        OpenRouter — there's no native OpenAI provider..."). */}
                    {s.acquisition.note ? (
                      <Text color={theme.accent.warning}>
                        {"     "}
                        {s.acquisition.note}
                      </Text>
                    ) : null}
                  </>
                ) : null}
              </Box>
            );
          })}
        </Box>
      ) : (
        <Text color={theme.fg.muted}>No secrets needed — every selected agent uses OAuth or is already configured.</Text>
      )}
      {totalOauth > 0 ? (
        <Box flexDirection="column">
          <Text bold>OAuth steps queued ({totalOauth})</Text>
          <Text color={theme.fg.muted}>
            These you'll run manually AFTER setup completes:
          </Text>
          {res.oauthSteps.map((o) => (
            <Box key={`${o.agentId}-${o.command}`} flexDirection="column">
              <Text color={o.mandatory ? theme.accent.warning : theme.fg.muted}>
                {"  "}
                {o.mandatory ? "⚠ MUST: " : "• "}
                {o.agentId}: <Text bold>{o.command}</Text>
              </Text>
              {o.mandatory && o.reason ? (
                <Text color={theme.fg.muted}>{"     "}{o.reason}</Text>
              ) : null}
            </Box>
          ))}
        </Box>
      ) : null}
      {/* QA round 4 — [o] used to be advertised unconditionally but
          it only does anything when the focused row is a secret with
          a populated acquisition URL. When the screen is showing the
          "all set" / "OAuth queue only" state there are no secrets,
          so [o] silently no-ops. Hide it then. */}
      <Text color={theme.fg.muted}>
        {res.secrets.length > 0
          ? "[↑↓] move · [Enter] paste · [o] open URL · [s] skip · [c] continue · [Esc] back"
          : "[c] continue · [Esc] back"}
      </Text>
      {!complete && totalErrors === 0 ? (
        <Text color={theme.accent.warning}>
          ⚠ {res.secrets.filter((s) => s.status === "missing").length} secret(s) still missing
        </Text>
      ) : null}
      {complete ? (
        <Text color={theme.accent.primary}>
          ✓ Ready to install — press [c] or [Enter] to continue
        </Text>
      ) : null}
    </Box>
  );
}
