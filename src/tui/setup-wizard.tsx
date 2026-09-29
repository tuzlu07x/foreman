import { useApp, useInput } from "ink";
import { type JSX, useMemo, useRef, useState } from "react";
import {
  detectMachineCapability,
  type MachineCapability,
} from "../core/machine-capability.js";
import { detectOllama } from "../core/ollama-detector.js";
import { loadOllamaModels } from "../core/ollama-models.js";
import { loadLlmPresets } from "../core/llm-provider-presets.js";
import {
  loadActiveProviders,
  loadActiveRegistry,
  loadActiveServices,
} from "../core/registry-catalog.js";
import { useLayout } from "./hooks.js";
import {
  markCompleted,
  markUncompleted,
  saveSetupState,
  STEPS,
  type Step,
} from "./setup-state.js";
import {
  useAgentConfigEffects,
  useLlmPickerOptions,
} from "./setup-wizard/agent-config-hooks.js";
import {
  handleAgentLlmChoiceInput,
  handleAgentModelPickInput,
  handleAgentHookChoiceInput,
  handleAgentVariantPickInput,
} from "./setup-wizard/agent-config-input.js";
import {
  handleAgentsConfirmInput,
  handleAgentsEscape,
  renderAgentsStep,
} from "./setup-wizard/agents.js";
import {
  handleChatPrimaryInput,
  renderChatPrimaryStep,
  useChatPrimaryAutoAdvance,
  useChatPrimaryChannelsNeeded,
} from "./setup-wizard/chat-primary.js";
import type { WizardContext } from "./setup-wizard/context.js";
import { handleDoneInput, renderDoneStep } from "./setup-wizard/done.js";
import { handleForemanLlmInput } from "./setup-wizard/foreman-llm-input.js";
import { renderForemanLlmStep } from "./setup-wizard/foreman-llm.js";
import {
  handleIntegrationsInput,
  renderIntegrationsStep,
} from "./setup-wizard/integrations.js";
import {
  handleInstallFailureInput,
  renderInstallStep,
  useInstallKickoff,
  useInstallSpinner,
} from "./setup-wizard/install.js";
import {
  handleProvidersEscape,
  renderProvidersStep,
} from "./setup-wizard/providers.js";
import {
  handleRequiredSetupInput,
  renderRequiredSetupStep,
  useRequiredSetupResolution,
} from "./setup-wizard/required-setup.js";
import {
  handleServicesEscape,
  renderServicesStep,
} from "./setup-wizard/services.js";
import { handleCtrlC, isModifiedLetter } from "./setup-wizard/quit.js";
import { planResume } from "./setup-wizard/resume.js";
import { snapshotSession, useWizardState } from "./setup-wizard/state.js";
import type {
  FailureResolution,
  QuitReason,
  SetupWizardProps,
} from "./setup-wizard/types.js";
import {
  handleTeamInput,
  renderTeamStep,
  useTeamAutoSkip,
} from "./setup-wizard/team.js";
import { teamRuntimes as registeredTeamRuntimes } from "./setup-wizard/team-logic.js";
import {
  handleWelcomeInput,
  renderWelcomeStep,
} from "./setup-wizard/welcome.js";

// =============================================================================
// First-run setup wizard (#621 split)
// =============================================================================
//
// This file is the wizard's orchestrator: it owns the shared state (one
// reducer, see setup-wizard/state.ts), derives the per-render values every
// step needs, and dispatches input + rendering to the step modules under
// setup-wizard/. Each step exports plain functions of a WizardContext:
//
//   render<Step>Step(ctx)          → the step's screen (JSX)
//   handle<Step>Input(ctx, …)      → true when the key was consumed
//
// Steps are called as functions, not mounted as components, so the rendered
// tree and render-time state updates are identical to the pre-split wizard.
// The public API (types, pure helpers, runInstallStep) is re-exported below
// so existing `./setup-wizard.js` imports keep working.

export function SetupWizard({
  initialState,
  services,
  afterExit = "exit",
  onQuit,
}: SetupWizardProps): JSX.Element {
  const { exit } = useApp();
  const quit = (reason: QuitReason = "quit"): void => {
    onQuit?.(reason);
    exit();
  };
  // Agents already registered in this Foreman home — drive the wizard's
  // diff logic: still-checked = no-op or re-verify; newly-checked = install;
  // previously-checked-now-unchecked = unregister (#657: uninstalling the
  // binary is a separate, explicit choice).
  const initialRegistered = useMemo(
    () => services.registry.list().map((a) => a.id),
    [services.registry],
  );
  // Memoize the catalog so MultiSelect doesn't re-mount and reset toggles.
  const providerCatalog = useMemo(
    () => loadActiveProviders().doc.providers,
    [],
  );
  // Memoize the catalog so MultiSelect doesn't re-mount on every render —
  // re-mount would reset the user's toggles back to defaultValue (#152).
  const agentCatalog = useMemo(() => loadActiveRegistry().doc.agents, []);
  const serviceCatalog = useMemo(() => loadActiveServices().doc.services, []);
  // A resumed session is reconciled with the live registry and catalog
  // once, before anything can act on it (setup-wizard/resume.ts).
  const [resumePlan] = useState(() =>
    planResume(initialState, initialRegistered, {
      agents: agentCatalog,
      providerIds: providerCatalog.map((p) => p.id),
      serviceIds: serviceCatalog.map((s) => s.id),
    }),
  );
  const { state, set } = useWizardState(
    resumePlan.setup,
    initialRegistered,
    resumePlan.agentsPhase ?? undefined,
  );
  const welcomeLayout = useLayout();
  const currentStep: Step = useMemo(() => {
    for (const s of STEPS) {
      if (!state.setup.completed.includes(s)) return s;
    }
    return "done";
  }, [state.setup]);

  const advance = (step: Step): void => {
    // Save the session-only choices with every completed step so a resumed
    // run doesn't lose them (setup-state.ts WizardSessionSnapshot).
    const session = snapshotSession(
      state,
      services.registry.list().map((a) => a.id),
    );
    set.setSetup((prev) => {
      const next = { ...markCompleted(prev, step), session };
      saveSetupState(next);
      return next;
    });
  };

  const uncomplete = (step: Step): void => {
    set.setSetup((prev) => {
      const next = markUncompleted(prev, step);
      saveSetupState(next);
      return next;
    });
  };

  const machineCap = useMemo<MachineCapability>(
    () => detectMachineCapability(),
    [],
  );
  const ollamaModelDoc = useMemo(() => loadOllamaModels(), []);
  const llmPresetDoc = useMemo(() => loadLlmPresets(), []);
  // Re-detect Ollama whenever we hit a foreman-llm phase that needs it —
  // user might have run `brew install ollama` in another terminal between
  // wizard renders.
  const ollamaDetection = useMemo(
    () => detectOllama(),
    [state.foremanLlmPhase, currentStep],
  );

  const llmPickerOptions = useLlmPickerOptions({
    agentsPhase: state.agentsPhase,
    agentConfigPrompts: state.agentConfigPrompts,
    agentConfigIdx: state.agentConfigIdx,
    agentCatalog,
    providerCatalog,
    providersSaved: state.providersSaved,
    providersSignedIn: state.providersSignedIn,
    services,
  });
  const requiredSetupResolution = useRequiredSetupResolution({
    agentCatalog,
    agentsSelected: state.agentsSelected,
    agentConfigs: state.agentConfigs,
    services,
    requiredSetupOverrides: state.requiredSetupOverrides,
  });
  const chatPrimaryChannelsNeeded = useChatPrimaryChannelsNeeded({
    servicesSelected: state.servicesSelected,
    agentsSelected: state.agentsSelected,
    agentCatalog,
  });

  // Read once the team step is reached: install has registered the agents.
  const teamRuntimes = useMemo(
    () =>
      currentStep === "team"
        ? registeredTeamRuntimes(services.registry.list().map((a) => a.id))
        : [],
    [currentStep, services.registry],
  );

  const failureResolverRef = useRef<
    ((resolution: FailureResolution) => void) | null
  >(null);

  const ctx: WizardContext = {
    services,
    exit,
    quit,
    afterExit,
    state,
    set,
    currentStep,
    advance,
    uncomplete,
    welcomeLayout,
    providerCatalog,
    agentCatalog,
    serviceCatalog,
    initialRegistered,
    machineCap,
    ollamaModelDoc,
    llmPresetDoc,
    ollamaDetection,
    llmPickerOptions,
    requiredSetupResolution,
    chatPrimaryChannelsNeeded,
    teamRuntimes,
    failureResolverRef,
  };

  // Effects, in their original declaration order.
  useChatPrimaryAutoAdvance(ctx);
  useAgentConfigEffects(ctx);
  useInstallKickoff(ctx);
  useInstallSpinner(ctx);
  useTeamAutoSkip(ctx);

  // Esc handler — phase-aware back navigation (#153). Stays out of the way
  // during install (no cancel mid-flight) and during welcome (let
  // ConfirmInput handle n=exit). Selections held in React state are
  // preserved across back-steps because we only mutate phase / completion.
  //
  // The handlers run in the original order; each returns true when it
  // consumed the key (stop) and false to fall through to the next.
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      handleCtrlC(ctx);
      return;
    }
    // Single-letter hotkeys never fire for Ctrl/Meta combos (setup-wizard/quit.ts).
    if (isModifiedLetter(input, key)) return;
    if (handleForemanLlmInput(ctx, input, key)) return;
    if (handleAgentVariantPickInput(ctx, input, key)) return;
    if (handleAgentModelPickInput(ctx, input, key)) return;
    if (handleAgentHookChoiceInput(ctx, input, key)) return;
    if (handleAgentLlmChoiceInput(ctx, input, key)) return;
    if (handleRequiredSetupInput(ctx, input, key)) return;
    if (handleChatPrimaryInput(ctx, input, key)) return;
    if (handleIntegrationsInput(ctx, input, key)) return;
    if (handleTeamInput(ctx, input, key)) return;
    if (handleDoneInput(ctx, input, key)) return;
    if (handleWelcomeInput(ctx, input, key)) return;
    if (handleInstallFailureInput(ctx, input, key)) return;
    if (handleAgentsConfirmInput(ctx, input)) return;

    if (!key.escape) return;
    if (handleProvidersEscape(ctx)) return;
    if (handleAgentsEscape(ctx)) return;
    handleServicesEscape(ctx);
  });

  if (currentStep === "welcome") return renderWelcomeStep(ctx);
  if (currentStep === "providers") {
    const view = renderProvidersStep(ctx);
    if (view) return view;
  }
  if (currentStep === "foreman-llm") return renderForemanLlmStep(ctx);
  if (currentStep === "agents") {
    const view = renderAgentsStep(ctx);
    if (view) return view;
  }
  if (currentStep === "services") {
    const view = renderServicesStep(ctx);
    if (view) return view;
  }
  if (currentStep === "integrations") return renderIntegrationsStep(ctx);
  if (currentStep === "chat-primary") return renderChatPrimaryStep(ctx);
  if (currentStep === "required-setup") return renderRequiredSetupStep(ctx);
  if (currentStep === "install") return renderInstallStep(ctx);
  if (currentStep === "team") return renderTeamStep(ctx);
  return renderDoneStep(ctx);
}

// ---------------------------------------------------------------------------
// Public API — re-exported so imports of "./setup-wizard.js" keep working.
// ---------------------------------------------------------------------------

export {
  applyAgentConfigSubmit,
  applyAgentsPickerSubmit,
  buildAgentConfigPromptList,
  classifyModelDiscoveryError,
  computeAgentDiff,
  computeSingleCompatProviderSeeds,
  findSiblingCredHint,
  type AgentConfigPrompt,
  type AgentConfigPromptKind,
  type AgentConfigSubmitInput,
  type AgentConfigSubmitResult,
  type AgentDiff,
  type AgentsPhase,
  type AgentsPickerSubmitResult,
} from "./setup-wizard/agents-logic.js";
export { countPolicyRules } from "./setup-wizard/done.js";
export {
  formatOllamaRunTag,
  type ForemanLlmChoice,
  type ForemanLlmPhase,
} from "./setup-wizard/foreman-llm-logic.js";
export { formatElapsed } from "./setup-wizard/install.js";
export { runInstallStep } from "./setup-wizard/install-runner.js";
export {
  applyProvidersPickerSubmit,
  applyProviderValueSubmit,
  buildProviderPromptList,
  storageNameForPrompt,
  type ProviderPrompt,
  type ProviderPromptKind,
  type ProvidersPhase,
  type ProvidersPickerSubmitResult,
  type ProviderValueSubmitInput,
  type ProviderValueSubmitResult,
} from "./setup-wizard/providers-logic.js";
export {
  applyServicesPickerSubmit,
  applyServiceValueSubmit,
  buildServicePromptList,
  consumingAgentsFor,
  type ServicePrompt,
  type ServicesPhase,
  type ServicesPickerSubmitResult,
  type ServiceValueSubmitInput,
  type ServiceValueSubmitResult,
} from "./setup-wizard/services-logic.js";
export {
  computePickerViewport,
  configuredBrainProviderIds,
  configuredProviderIds,
  configuredServiceIds,
  type PickerViewport,
} from "./setup-wizard/shared.js";
export type {
  AgentConfig,
  AgentConfigsMap,
  AgentInstallFailure,
  AgentInstallStage,
  FailureResolution,
  InstallStepProjectionContext,
  InstallStepSummary,
  OnAgentInstallFailure,
  SetupWizardProps,
  WizardOauthRunStep,
  WizardServices,
} from "./setup-wizard/types.js";
export {
  totalEstimatedMinutes,
  WELCOME_STEPS,
  type WelcomeStep,
} from "./setup-wizard/welcome.js";
