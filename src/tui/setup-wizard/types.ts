import type { ChatPrimaryService } from "../../core/chat-primary.js";
import type { RegistryService } from "../../core/registry.js";
import type { SecretStore } from "../../core/secret-store.js";
import type { ForemanDb } from "../../db/client.js";
import type { SetupState } from "../setup-state.js";

export interface WizardServices {
  db: ForemanDb;
  secretStore: SecretStore;
  registry: RegistryService;
  /** #426 — Primary chat agent per messaging channel. Wizard's
   *  chat-primary step writes here; the projector reads it via the
   *  ProjectionContext. Wizard caller is responsible for instantiating
   *  + passing this; defaults to a no-op service when omitted (legacy). */
  chatPrimary?: ChatPrimaryService;
  policyPath: string;
  /** Path to llm.yaml — wizard writes here after providers step (#289). */
  llmConfigPath: string;
  /** Path to notify.yaml — wizard writes here after services step (#290). */
  notifyConfigPath: string;
  /** Path to voice.yaml — wizard seeds here after services step (#305).
   *  ForemanVoice + PatternDetectionService read from this on startup. */
  voiceConfigPath: string;
  launchEditor: (path: string) => Promise<unknown>;
  /** #468 — When the Done screen's [y] hotkey is pressed, the wizard
   *  exits and hands off these OAuth/interactive_setup commands to the
   *  outer CLI for inline browser-flow execution. The CLI spawns them
   *  with inherited stdio so the user's browser actually opens. */
  requestOauthRun?: (steps: WizardOauthRunStep[]) => void;
}

export interface WizardOauthRunStep {
  agentId: string;
  command: string;
  verify: string | null;
  mandatory: boolean;
  reason: string | null;
}

export interface SetupWizardProps {
  initialState: SetupState;
  services: WizardServices;
  /** What the host does once the wizard exits: `foreman start` goes on to
   *  launch the TUI, `foreman setup` just exits. Drives the Done screen's
   *  [Enter] label so it doesn't promise a TUI that never opens. Default
   *  `"exit"`. */
  afterExit?: "exit" | "launch-tui";
  /** Called when the user quits (Ctrl-C, or [q] on Welcome) rather than
   *  finishing. The host must not carry on as if setup completed —
   *  `foreman start` uses it to exit instead of launching the TUI.
   *  `reason` is `"interrupt"` for Ctrl-C, so the host can exit with 130
   *  like any interrupted Unix command. */
  onQuit?: (reason: QuitReason) => void;
}

/** Why the wizard quit: Ctrl-C (`interrupt`) or a quit key (`quit`). */
export type QuitReason = "interrupt" | "quit";

export interface AgentConfig {
  llmProvider?: string;
  /** #450 — Variant id within the chosen llmProvider's mapping
   *  (e.g. "via-openrouter" or "via-codex-oauth" for Hermes/openai).
   *  Optional; falls back to the registry's `preferred` when unset. */
  providerVariant?: string;
  /** #434 — Specific model id chosen for this agent (e.g.
   *  claude-opus-4-7). Optional; falls back to the variant default. */
  modelVersion?: string;
  responsibilityNote?: string;
}

export type AgentConfigsMap = Record<string, AgentConfig | undefined>;

export interface InstallStepSummary {
  registered: string[];
  identityPushed: string[];
  identitySkipped: { agentId: string; reason: string }[];
  /** Registered agents whose registry entry has no identity file (e.g.
   *  generic-mcp). There is nothing to push, which is not a failure, so
   *  these are kept out of identitySkipped. */
  identityNotApplicable: string[];
  failed: string[];
  removed: string[];
  /** #audit-finding-15 — Agents whose Foreman MCP registration failed
   *  during install (auto-run command refused, wrapper write blocked,
   *  Hermes' `hermes mcp add` errored). The agent runs but its MCP
   *  client can't reach Foreman — silent degradation. Done screen
   *  surfaces these with the manual fallback command so the user can
   *  re-run after fixing the underlying issue. */
  mcpRegisterFailed: { agentId: string; command: string; reason: string }[];
  /** #646 — Agents not installed because the node on PATH is outside the
   *  agent's `engines.node` range. `lines` explains the requirement and
   *  the upstream installer command for the user to run themselves. */
  nodeEngineSkipped: { agentId: string; lines: string[] }[];
  /** #618 — Registered agents given an identity token that Foreman had
   *  nowhere to write (no MCP config or wrapper in the registry, e.g.
   *  generic-mcp). Done shows how to fetch it; never the token itself. */
  tokenToWire: string[];
}

export type AgentInstallStage = "install" | "config-inject" | "register";

export interface AgentInstallFailure {
  agentId: string;
  agentName: string;
  stage: AgentInstallStage;
  error: string;
  manualHint: string;
}

export type FailureResolution = "retry" | "skip" | "continue";

export type OnAgentInstallFailure = (
  failure: AgentInstallFailure,
) => Promise<FailureResolution>;

export interface InstallStepProjectionContext {
  providersSelected: string[];
  servicesSelected: string[];
}
