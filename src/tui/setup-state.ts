import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getForemanPaths } from "../utils/config.js";

export const STEPS = [
  "welcome",
  "providers",
  "foreman-llm",
  "agents",
  "services",
  // #426 — Primary chat agent per messaging channel. Runs after
  // services so we know which channels are in play, before
  // required-setup so the projector knows which agent gets the
  // channel's secrets. Auto-skipped when there's no conflict
  // (<=1 chat-capable agent OR no messaging service).
  "chat-primary",
  // #408 / #411 Phase 3 — per-agent provider mapping resolution.
  // Runs AFTER agent + service picks (needs both to compute which
  // secrets are required) and BEFORE install (so missing keys are
  // pasted in before the projector writes them).
  "required-setup",
  "install",
  "done",
] as const;
export type Step = (typeof STEPS)[number];

/** Per-agent choices made in the wizard's agents step. */
export interface SessionAgentConfig {
  llmProvider?: string;
  providerVariant?: string;
  modelVersion?: string;
  responsibilityNote?: string;
}

/**
 * Wizard choices that only lived in React state, saved with each completed
 * step so `foreman setup --resume` (and `foreman start`'s resume) picks them
 * up again. Without it a resumed run registered multi-provider agents with
 * no LLM provider, dropped the selected services from secret projection and
 * forgot queued subscription sign-ins. Ids and notes only — never a secret
 * value; those stay in the encrypted secret store.
 */
export interface WizardSessionSnapshot {
  providersSelected: string[];
  providersSignedIn: ("anthropic" | "openai")[];
  agentsSelected: string[];
  agentConfigs: Record<string, SessionAgentConfig>;
  servicesSelected: string[];
}

export interface SetupState {
  version: 1;
  completed: Step[];
  startedAt: number;
  lastUpdatedAt: number;
  /** Set when the user explicitly chose to skip setup from `foreman start`.
   * Prevents the prompt from re-firing on every subsequent run (#160). */
  skippedAt?: number;
  /** Optional so setup-state files written before it existed still load. */
  session?: WizardSessionSnapshot;
}

export function getSetupStatePath(): string {
  return resolve(getForemanPaths().configDir, "setup-state.json");
}

export function freshState(): SetupState {
  const now = Date.now();
  return {
    version: 1,
    completed: [],
    startedAt: now,
    lastUpdatedAt: now,
  };
}

export function loadSetupState(path: string = getSetupStatePath()): SetupState {
  if (!existsSync(path)) return freshState();
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!isValidState(raw)) return freshState();
    // A damaged session snapshot must not cost the user their completed
    // steps: keep the progress, drop only the snapshot.
    const state: SetupState = { ...raw };
    delete state.session;
    const session = sanitizeSession(raw.session);
    return session ? { ...state, session } : state;
  } catch {
    return freshState();
  }
}

export function saveSetupState(
  state: SetupState,
  path: string = getSetupStatePath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ ...state, lastUpdatedAt: Date.now() }, null, 2),
    "utf-8",
  );
}

export function resetSetupState(path: string = getSetupStatePath()): void {
  if (existsSync(path)) rmSync(path);
}

// First step whose name is not in `completed`. Used by --resume to skip
// already-finished steps.
export function nextStep(state: SetupState): Step {
  for (const s of STEPS) {
    if (!state.completed.includes(s)) return s;
  }
  return "done";
}

export function markCompleted(state: SetupState, step: Step): SetupState {
  if (state.completed.includes(step)) return state;
  return {
    ...state,
    completed: [...state.completed, step],
    lastUpdatedAt: Date.now(),
  };
}

export function markSetupSkipped(
  state: SetupState,
  at: number = Date.now(),
): SetupState {
  return {
    ...state,
    skippedAt: at,
    lastUpdatedAt: at,
  };
}

// True if the user has either completed a setup step or explicitly opted out
// via `foreman start` → [s]. Used to decide whether to re-prompt on every
// subsequent run (#160).
export function hasUserOptedOut(state: SetupState): boolean {
  if (state.completed.length > 0) return true;
  return typeof state.skippedAt === "number";
}

// Removes the step and every later step from `completed` so the wizard
// re-flows from this step on next render. Used by Esc back-navigation —
// without dropping later steps, going back leaves a gap that nextStep()
// would skip over.
export function markUncompleted(state: SetupState, step: Step): SetupState {
  const stepIdx = STEPS.indexOf(step);
  if (stepIdx === -1) return state;
  const filtered = state.completed.filter((s) => STEPS.indexOf(s) < stepIdx);
  if (filtered.length === state.completed.length) return state;
  return {
    ...state,
    completed: filtered,
    lastUpdatedAt: Date.now(),
  };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Validated copy of a stored session snapshot, or undefined when absent or
 *  malformed. Unknown per-agent fields are dropped. */
export function sanitizeSession(raw: unknown): WizardSessionSnapshot | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (
    !isStringArray(r.providersSelected) ||
    !isStringArray(r.providersSignedIn) ||
    !isStringArray(r.agentsSelected) ||
    !isStringArray(r.servicesSelected) ||
    typeof r.agentConfigs !== "object" ||
    r.agentConfigs === null
  ) {
    return undefined;
  }
  const signedIn = r.providersSignedIn.filter(
    (p): p is "anthropic" | "openai" => p === "anthropic" || p === "openai",
  );
  const agentConfigs: Record<string, SessionAgentConfig> = {};
  for (const [id, cfgRaw] of Object.entries(r.agentConfigs)) {
    if (typeof cfgRaw !== "object" || cfgRaw === null) continue;
    const c = cfgRaw as Record<string, unknown>;
    const cfg: SessionAgentConfig = {};
    const llmProvider = optionalString(c.llmProvider);
    const providerVariant = optionalString(c.providerVariant);
    const modelVersion = optionalString(c.modelVersion);
    const responsibilityNote = optionalString(c.responsibilityNote);
    if (llmProvider !== undefined) cfg.llmProvider = llmProvider;
    if (providerVariant !== undefined) cfg.providerVariant = providerVariant;
    if (modelVersion !== undefined) cfg.modelVersion = modelVersion;
    if (responsibilityNote !== undefined) cfg.responsibilityNote = responsibilityNote;
    agentConfigs[id] = cfg;
  }
  return {
    providersSelected: [...r.providersSelected],
    providersSignedIn: signedIn,
    agentsSelected: [...r.agentsSelected],
    agentConfigs,
    servicesSelected: [...r.servicesSelected],
  };
}

function isValidState(raw: unknown): raw is SetupState {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Partial<SetupState>;
  if (r.version !== 1) return false;
  if (!Array.isArray(r.completed)) return false;
  if (typeof r.startedAt !== "number") return false;
  if (typeof r.lastUpdatedAt !== "number") return false;
  for (const s of r.completed) {
    if (!STEPS.includes(s as Step)) return false;
  }
  return true;
}
