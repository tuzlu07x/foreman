import {
  type Dispatch,
  type SetStateAction,
  useMemo,
  useReducer,
} from "react";
import type { DoctorReport } from "../../core/doctor.js";
import type { DiscoveredModel } from "../../core/llm/models-discovery.js";
import {
  pickSessionAgentConfig,
  type SetupState,
  type WizardSessionSnapshot,
} from "../setup-state.js";
import type {
  AgentConfigPrompt,
  AgentsPhase,
} from "./agents-logic.js";
import type { ForemanLlmPhase } from "./foreman-llm-logic.js";
import type {
  IntegrationDraft,
  IntegrationResult,
  IntegrationsPhase,
} from "./integrations-logic.js";
import type {
  ProviderPrompt,
  ProvidersPhase,
} from "./providers-logic.js";
import type { ServicesPhase } from "./services-logic.js";
import type {
  TeamCustomRole,
  TeamDepartment,
  TeamPhase,
  TeamResult,
  TeamRuntime,
} from "./team-logic.js";
import { DEFAULT_AGENTS } from "./shared.js";
import type {
  AgentConfigsMap,
  AgentInstallFailure,
  InstallStepSummary,
} from "./types.js";

// =============================================================================
// Setup wizard shared state (#621)
// =============================================================================
//
// Every piece of state the wizard's steps share lives in one reducer-owned
// object. The reducer is deliberately a thin wrapper: its only action is
// "set one field", with the same value-or-updater semantics as React's
// useState setter. That keeps every state transition byte-for-byte what it
// was when each field was its own useState — the refactor that introduced it
// had to be a pure, no-behaviour-change split — while giving the steps one
// typed state shape and one setter surface (`set.setX`) to share.

export interface WizardState {
  /** Persisted step-completion record (setup-state.json). */
  setup: SetupState;

  providersSelected: string[];
  providerPrompts: ProviderPrompt[];
  providerIdx: number;
  providersPhase: ProvidersPhase;
  providersSaved: string[];
  providersSkipped: string[];
  // Faz 4b-3 / #512 — per OAuth-capable provider (anthropic, openai) the user
  // selected, the values phase asks "API key or sign in with subscription?".
  // `providersSignedIn` carries those that chose sign-in (no key paste, set
  // `auth_mode: oauth` in llm.yaml, queue `foreman llm login <provider>` for
  // post-wizard execution). `authModeAsked` debounces the prompt so each
  // provider is asked at most once per wizard run.
  providersSignedIn: ("anthropic" | "openai")[];
  authModeAsked: string[];
  providersWarning: string | null;

  agentsSelected: string[];
  agentsPhase: AgentsPhase;
  // What the agents picker currently has checked (MultiSelect onChange);
  // null until the user toggles something, then the pre-checked defaults
  // apply. Reset whenever the picker is left, since it remounts with its
  // defaults next time.
  agentsPickerChecked: string[] | null;
  agentConfigPrompts: AgentConfigPrompt[];
  agentConfigIdx: number;
  agentConfigs: AgentConfigsMap;
  llmDraft: string | null;
  // Unticked agents are only unregistered unless the user asks, on the
  // confirm screen, to uninstall the ones Foreman installed (#657).
  uninstallRemoved: boolean;

  // #367 — Foreman's own LLM (verifier + smart summary). The wizard's new
  // Step 2 makes this an explicit choice instead of silently picking the
  // first configured provider from Step 1.
  foremanLlmPhase: ForemanLlmPhase;
  foremanLlmDraft: string | null;
  // #399 — live model picker. After the user picks a cloud provider, we
  // fetch the actual available models for their key and let them choose.
  // Loading → null options + null error. Error → null options + error msg.
  // Success → options array, error null. Draft is the bare model id.
  cloudModelProvider: "openai" | "anthropic" | "gemini" | null;
  cloudModelOptions: DiscoveredModel[] | null;
  cloudModelError: string | null;
  // Non-error notice for an empty model list — e.g. the provider is a
  // subscription sign-in with nothing to list (#575 follow-up).
  cloudModelInfo: string | null;
  cloudModelDraft: string | null;
  ollamaModelDraft: string | null;
  presetDraft: string | null;
  presetKeyDraft: string;
  // Self-hosted brains (Ollama, a custom OpenAI-compatible server): the
  // validated base URL the user entered, and why the last entry was
  // rejected. Their live model list reuses cloudModelOptions / Error /
  // Draft above.
  brainBaseUrl: string | null;
  brainBaseUrlError: string | null;

  // #434 — Per-agent model picker state. `agentModelOptions` is the
  // live-discovered model list for the active prompt's provider;
  // `agentModelDraft` is the highlighted choice. Both reset when the
  // prompt index changes (effect below). Loading = options===null,
  // error = options===[] + error set.
  agentModelOptions: DiscoveredModel[] | null;
  agentModelError: string | null;
  agentModelDraft: string | null;

  // #450 — Per-agent variant picker draft. Holds the highlighted
  // variant id for the active model-pick prompt; persisted into
  // agentConfigs[id].providerVariant on commit.
  agentVariantDraft: string | null;

  // #457 — When the preferred variant needs no extra credentials, the
  // variant picker auto-skips and records the choice here so the
  // required-setup screen can flash a "Foreman picked the X route — switch
  // later with `foreman provider switch ...`" notice. Map: agentId → variant
  // label.
  autoPickedVariants: Record<string, { variantId: string; label: string }>;

  // #408 / #411 Phase 3 — required-setup step state.
  // The wizard precomputes a `RequiredSetupResolution` (which agents need
  // which secrets, which OAuth flows queue up). User can paste missing
  // keys or [s]kip them; skipped + missing secrets will block install
  // until handled.
  requiredSetupPhase: "picker" | "paste";
  requiredSetupCursor: number;
  requiredSetupPasteValue: string;
  requiredSetupOverrides: Record<string, "saved-in-session" | "skipped">;

  servicesSelected: string[];
  serviceIdx: number;
  servicesPhase: ServicesPhase;
  servicesSaved: string[];
  servicesSkipped: string[];
  servicesWarning: string | null;
  /** A pasted secret held back because it failed its paste check; the same
   *  value submitted again at that prompt is saved. Never snapshotted. */
  servicesPendingPaste: { secretName: string; value: string } | null;
  /** Slack channel / Discord channel id per service id, for notify.yaml. */
  servicesChannelTargets: Record<string, string>;

  // Integrations step (docs/plans/integrations.md §7). `integrationDraft`
  // holds a typed credential only until that integration is saved.
  /** Every id picked in this setup (a resume restores it); the Done
   *  screen lists the ones still off. */
  integrationsSelected: string[];
  /** The ids being configured in the current pass through the picker. */
  integrationQueue: string[];
  integrationsPhase: IntegrationsPhase;
  integrationIdx: number;
  integrationDraft: IntegrationDraft | null;
  integrationResults: IntegrationResult[];
  integrationsWarning: string | null;

  chatPrimaryChannelIdx: number;
  chatPrimaryCursor: number;
  chatPrimaryDrafts: Record<string, string>;

  installLog: string[];
  installRunning: boolean;
  installSummary: InstallStepSummary | null;
  pendingFailure: AgentInstallFailure | null;
  installStartedAt: number | null;
  spinnerFrame: number;
  manualFixOpen: boolean;
  // Ctrl-C pressed while the installer runs → show a quit notice.
  installQuitNotice: boolean;
  // The install runner has resolved or rejected (Ctrl-C may quit then).
  installSettled: boolean;

  teamPhase: TeamPhase;
  teamCursor: number;
  /** Picked rows: `preset:<id>` or `custom:<index>`. */
  teamPicked: string[];
  /** Per row, Claude Code or Codex when you switched it ([r]). */
  teamRunsOn: Record<string, TeamRuntime>;
  teamCustom: TeamCustomRole[];
  teamDraft: TeamCustomRole | null;
  teamCanCursor: number;
  /** Departments added ([Enter] on "+ Add a department…"). */
  teamDepartments: TeamDepartment[];
  /** The department being added: a ready-made one or yours. */
  teamDeptDraft: Omit<TeamDepartment, "key"> | null;
  /** Cursor of the department lists (dept-pick, dept-runtime, custom-dept). */
  teamDeptCursor: number;
  teamResult: TeamResult | null;

  donePhase: "main" | "doctor" | "log";
  doctorReport: DoctorReport | null;
}

export function createInitialWizardState(
  initialState: SetupState,
  // Agents already registered in this Foreman home — drive the wizard's
  // diff logic: still-checked = no-op or re-verify; newly-checked = install;
  // previously-checked-now-unchecked = unregister.
  initialRegistered: string[],
  // Set by planResume when a resume re-opened the agents step.
  initialAgentsPhase: AgentsPhase = "picker",
): WizardState {
  // Choices saved by a previous run of this setup (resume); see
  // snapshotSession. The root reconciles them first (planResume).
  const session = initialState.session;
  return {
    setup: initialState,

    providersSelected: session?.providersSelected ?? [],
    providerPrompts: [],
    providerIdx: 0,
    providersPhase: "picker",
    providersSaved: [],
    providersSkipped: [],
    providersSignedIn: session?.providersSignedIn ?? [],
    authModeAsked: [],
    providersWarning: null,

    agentsSelected:
      session?.agentsSelected ??
      (initialRegistered.length > 0 ? initialRegistered : DEFAULT_AGENTS),
    agentsPhase: initialAgentsPhase,
    agentsPickerChecked: null,
    agentConfigPrompts: [],
    agentConfigIdx: 0,
    agentConfigs: session?.agentConfigs ?? {},
    llmDraft: null,
    uninstallRemoved: false,

    foremanLlmPhase: "picker",
    foremanLlmDraft: null,
    cloudModelProvider: null,
    cloudModelOptions: null,
    cloudModelError: null,
    cloudModelInfo: null,
    cloudModelDraft: null,
    ollamaModelDraft: null,
    presetDraft: null,
    presetKeyDraft: "",
    brainBaseUrl: null,
    brainBaseUrlError: null,

    agentModelOptions: null,
    agentModelError: null,
    agentModelDraft: null,
    agentVariantDraft: null,
    autoPickedVariants: {},

    requiredSetupPhase: "picker",
    requiredSetupCursor: 0,
    requiredSetupPasteValue: "",
    requiredSetupOverrides: {},

    servicesSelected: session?.servicesSelected ?? [],
    serviceIdx: 0,
    servicesPhase: "picker",
    servicesSaved: [],
    servicesSkipped: [],
    servicesWarning: null,
    servicesPendingPaste: null,
    servicesChannelTargets: {},

    integrationsSelected: session?.integrationsSelected ?? [],
    integrationQueue: [],
    integrationsPhase: "picker",
    integrationIdx: 0,
    integrationDraft: null,
    integrationResults: [],
    integrationsWarning: null,

    chatPrimaryChannelIdx: 0,
    chatPrimaryCursor: 0,
    chatPrimaryDrafts: {},

    installLog: [],
    installRunning: false,
    installSummary: null,
    pendingFailure: null,
    installStartedAt: null,
    spinnerFrame: 0,
    manualFixOpen: false,
    installQuitNotice: false,
    installSettled: false,

    teamPhase: "pick",
    teamCursor: 0,
    teamPicked: [],
    teamRunsOn: {},
    teamCustom: [],
    teamDraft: null,
    teamCanCursor: 0,
    teamDepartments: [],
    teamDeptDraft: null,
    teamDeptCursor: 0,
    teamResult: null,

    donePhase: "main",
    doctorReport: null,
  };
}

/** The session-only choices worth keeping across a resume, plus the live
 *  registry ids they were made against (planResume compares them). */
export function snapshotSession(
  state: WizardState,
  registered: readonly string[],
): WizardSessionSnapshot {
  const agentConfigs: WizardSessionSnapshot["agentConfigs"] = {};
  for (const [id, cfg] of Object.entries(state.agentConfigs)) {
    // Same four-field whitelist the loader applies (sanitizeSession).
    if (cfg) agentConfigs[id] = pickSessionAgentConfig({ ...cfg });
  }
  return {
    providersSelected: [...state.providersSelected],
    providersSignedIn: [...state.providersSignedIn],
    agentsSelected: [...state.agentsSelected],
    agentConfigs,
    servicesSelected: [...state.servicesSelected],
    // Ids only: integrationDraft (which may hold a credential) is never
    // part of the snapshot.
    integrationsSelected: [...state.integrationsSelected],
    registeredAtSnapshot: [...registered],
    teamStep: true,
  };
}

export type WizardAction = {
  [K in keyof WizardState]: {
    type: "set";
    key: K;
    value: SetStateAction<WizardState[K]>;
  };
}[keyof WizardState];

// `WizardAction` pairs each key with its own value type at the dispatch
// site; here the pair is handled uniformly, which TypeScript can only
// express over the widened key/value.
function applySet(
  state: WizardState,
  key: keyof WizardState,
  value: unknown,
): WizardState {
  const prev: unknown = state[key];
  // No WizardState field holds a function, so a function value is always
  // an updater — the same rule React's useState setter applies.
  const next: unknown =
    typeof value === "function"
      ? (value as (p: unknown) => unknown)(prev)
      : value;
  // Same bail-out as useState: an identical value keeps the same state
  // object, so memo deps and effects see no change.
  if (Object.is(prev, next)) return state;
  return { ...state, [key]: next };
}

export function wizardReducer(
  state: WizardState,
  action: WizardAction,
): WizardState {
  switch (action.type) {
    case "set":
      return applySet(state, action.key, action.value);
  }
}

type SetterName<K extends string> = `set${Capitalize<K>}`;

/** One `setX` per WizardState field, each shaped like a useState setter. */
export type WizardSetters = {
  [K in keyof WizardState as SetterName<K>]: Dispatch<
    SetStateAction<WizardState[K]>
  >;
};

export function setterName<K extends keyof WizardState>(
  key: K,
): SetterName<K> {
  return `set${key.charAt(0).toUpperCase()}${key.slice(1)}` as SetterName<K>;
}

export function buildWizardSetters(
  dispatch: Dispatch<WizardAction>,
  keys: readonly (keyof WizardState)[],
): WizardSetters {
  const setters: Record<string, (value: never) => void> = {};
  for (const key of keys) {
    setters[setterName(key)] = (value: never) =>
      dispatch({ type: "set", key, value } as WizardAction);
  }
  return setters as WizardSetters;
}

export interface WizardStateHandle {
  state: WizardState;
  set: WizardSetters;
}

export function useWizardState(
  initialState: SetupState,
  initialRegistered: string[],
  initialAgentsPhase?: AgentsPhase,
): WizardStateHandle {
  const [state, dispatch] = useReducer(
    wizardReducer,
    { initialState, initialRegistered, initialAgentsPhase },
    (args) =>
      createInitialWizardState(
        args.initialState,
        args.initialRegistered,
        args.initialAgentsPhase,
      ),
  );
  // dispatch is stable for the component's lifetime, so the setters are
  // built once and stay stable too — the same guarantee the individual
  // useState setters gave. The key set never changes after mount.
  const set = useMemo(
    () =>
      buildWizardSetters(
        dispatch,
        Object.keys(state) as (keyof WizardState)[],
      ),
    [],
  );
  return { state, set };
}
