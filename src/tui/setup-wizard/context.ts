import type { RefObject } from "react";
import type { MachineCapability } from "../../core/machine-capability.js";
import type { OllamaDetection } from "../../core/ollama-detector.js";
import type { OllamaModelDoc } from "../../core/ollama-models.js";
import type { LlmPresetDoc } from "../../core/llm-provider-presets.js";
import type {
  AgentEntry,
  ProviderEntry,
  ServiceEntry,
} from "../../core/registry-catalog.js";
import type { RequiredSetupResolution } from "../../core/required-setup.js";
import type { Layout } from "../layout.js";
import type { Step } from "../setup-state.js";
import type { ChatPrimaryChannel } from "./chat-primary.js";
import type { WizardSetters, WizardState } from "./state.js";
import type { FailureResolution, WizardServices } from "./types.js";

/**
 * Everything a wizard step needs, computed once per render by the root
 * `SetupWizard` component. Step render functions and input handlers are
 * plain functions of this context: they are called from the root's render
 * and `useInput` handler (not mounted as child components), so render-time
 * state updates and the rendered tree stay exactly as they were before the
 * #621 split.
 */
export interface WizardContext {
  services: WizardServices;
  exit: () => void;
  afterExit: "exit" | "launch-tui";
  state: WizardState;
  set: WizardSetters;
  currentStep: Step;
  advance: (step: Step) => void;
  uncomplete: (step: Step) => void;
  welcomeLayout: Layout;
  providerCatalog: ProviderEntry[];
  agentCatalog: AgentEntry[];
  serviceCatalog: ServiceEntry[];
  initialRegistered: string[];
  machineCap: MachineCapability;
  ollamaModelDoc: OllamaModelDoc;
  llmPresetDoc: LlmPresetDoc;
  ollamaDetection: OllamaDetection;
  llmPickerOptions: string[];
  requiredSetupResolution: RequiredSetupResolution;
  chatPrimaryChannelsNeeded: ChatPrimaryChannel[];
  failureResolverRef: RefObject<((resolution: FailureResolution) => void) | null>;
}
