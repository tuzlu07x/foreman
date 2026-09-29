import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getForemanPaths } from "../utils/config.js";

export const STEPS = [
  "welcome",
  "providers",
  "foreman-llm",
  "agents",
  "services",
  // Integrations (GitHub, GitLab, Jira/Confluence, Trello, Linear, Notion):
  // optional and skippable. Saved disabled; they're reviewed (and signed
  // in to) after setup. See docs/plans/integrations.md §7.
  "integrations",
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
  // Optional: roles on Claude Code / Codex instances (org.yaml). Skipped
  // on its own when neither is registered.
  "team",
  "done",
] as const;
export type Step = (typeof STEPS)[number];

/** Per-agent choices made in the wizard's agents step. */
export interface SessionAgentConfig {
  llmProvider?: string;
  providerVariant?: string;
  modelVersion?: string;
  responsibilityNote?: string;
  preToolUseHook?: boolean;
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
  /** Integration ids picked in the Integrations step. Ids only — the
   *  credentials go straight to the encrypted secret store. Absent in
   *  snapshots written before the step existed. */
  integrationsSelected?: string[];
  /** Live registry ids when the snapshot was saved. A resume compares it
   *  with the registry now; any difference re-opens the agents confirm
   *  step (planResume). Absent in snapshots written before it existed. */
  registeredAtSnapshot?: string[];
  /** Written by a wizard that has the "Your team" step: its install isn't
   *  the last step, so resume offers the team step (migrateCompleted). */
  teamStep?: true;
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
    const state: SetupState = migrateCompleted({ ...raw });
    delete state.session;
    const session = sanitizeSession(raw.session);
    return session ? { ...state, session } : state;
  } catch {
    return freshState();
  }
}

/** Steps added after a user's setup-state.json was written count as done
 *  once a later step is: an existing setup must not be sent back into the
 *  wizard for an optional step it never saw (the Integrations step). */
const BACKFILLED_STEPS: readonly Step[] = ["integrations"];

function migrateCompleted(state: SetupState): SetupState {
  let completed = state.completed;
  for (const step of BACKFILLED_STEPS) {
    if (completed.includes(step)) continue;
    const idx = STEPS.indexOf(step);
    if (completed.some((s) => STEPS.indexOf(s) > idx)) {
      completed = [...completed, step].sort(
        (a, b) => STEPS.indexOf(a) - STEPS.indexOf(b),
      );
    }
  }
  // The optional team step comes after install: a setup that got past
  // install before the step existed is finished (roles can be added with
  // `foreman org add-role`).
  const knowsTeam = (state.session as { teamStep?: unknown } | undefined)?.teamStep === true;
  if (!knowsTeam && completed.includes("install") && !completed.includes("team")) {
    completed = [...completed, "team"];
  }
  return completed === state.completed ? state : { ...state, completed };
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

/** The slice of the registry a session snapshot is checked against. */
export interface SessionCatalogAgent {
  id: string;
  llm_compat?: string[];
  provider_mapping?: Record<string, { variants: Record<string, unknown> }> | null;
}

export interface SessionCatalog {
  agents: SessionCatalogAgent[];
  providerIds: string[];
  serviceIds: string[];
}

/** Validated copy of a stored session snapshot, or undefined when absent or
 *  malformed. Per-agent configs keep only the four known fields. With a
 *  `catalog`, ids the registry no longer knows are dropped too: agents,
 *  providers, services, and per-agent providers / variants. */
export function sanitizeSession(
  raw: unknown,
  catalog?: SessionCatalog,
): WizardSessionSnapshot | undefined {
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
  const agents = catalog
    ? new Map(catalog.agents.map((a) => [a.id, a]))
    : null;
  const knownProvider = (id: string): boolean =>
    !catalog || catalog.providerIds.includes(id);
  const knownService = (id: string): boolean =>
    !catalog || catalog.serviceIds.includes(id);
  const knownAgent = (id: string): boolean => !agents || agents.has(id);
  const agentConfigs: Record<string, SessionAgentConfig> = {};
  for (const [id, cfgRaw] of Object.entries(r.agentConfigs)) {
    if (typeof cfgRaw !== "object" || cfgRaw === null) continue;
    if (!knownAgent(id)) continue;
    const cfg = pickSessionAgentConfig(cfgRaw as Record<string, unknown>);
    const entry = agents?.get(id);
    if (entry) dropUnknownRoute(cfg, entry);
    agentConfigs[id] = cfg;
  }
  const out: WizardSessionSnapshot = {
    providersSelected: r.providersSelected.filter(knownProvider),
    providersSignedIn: signedIn,
    agentsSelected: r.agentsSelected.filter(knownAgent),
    agentConfigs,
    servicesSelected: r.servicesSelected.filter(knownService),
  };
  if (isStringArray(r.integrationsSelected)) {
    out.integrationsSelected = [...r.integrationsSelected];
  }
  // Kept verbatim: it describes the registry, not the catalog.
  if (isStringArray(r.registeredAtSnapshot)) {
    out.registeredAtSnapshot = [...r.registeredAtSnapshot];
  }
  if (r.teamStep === true) out.teamStep = true;
  return out;
}

/** Only the four per-agent fields the wizard owns — anything else found in
 *  a stored or in-memory config is dropped rather than persisted. */
export function pickSessionAgentConfig(
  c: Record<string, unknown>,
): SessionAgentConfig {
  const cfg: SessionAgentConfig = {};
  const llmProvider = optionalString(c.llmProvider);
  const providerVariant = optionalString(c.providerVariant);
  const modelVersion = optionalString(c.modelVersion);
  const responsibilityNote = optionalString(c.responsibilityNote);
  if (llmProvider !== undefined) cfg.llmProvider = llmProvider;
  if (providerVariant !== undefined) cfg.providerVariant = providerVariant;
  if (modelVersion !== undefined) cfg.modelVersion = modelVersion;
  if (responsibilityNote !== undefined) cfg.responsibilityNote = responsibilityNote;
  if (typeof c.preToolUseHook === "boolean") cfg.preToolUseHook = c.preToolUseHook;
  return cfg;
}

// A provider the agent can't use, or a variant its mapping doesn't declare
// (registry changed since the snapshot), is dropped; the wizard re-asks.
function dropUnknownRoute(cfg: SessionAgentConfig, agent: SessionCatalogAgent): void {
  const compat = agent.llm_compat ?? [];
  if (cfg.llmProvider !== undefined && !compat.includes(cfg.llmProvider)) {
    delete cfg.llmProvider;
    delete cfg.providerVariant;
    delete cfg.modelVersion;
  }
  if (cfg.providerVariant === undefined) return;
  const provider =
    cfg.llmProvider ?? (compat.length === 1 ? compat[0] : undefined);
  const variants = provider
    ? agent.provider_mapping?.[provider]?.variants
    : undefined;
  if (!variants || !(cfg.providerVariant in variants)) {
    delete cfg.providerVariant;
  }
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
