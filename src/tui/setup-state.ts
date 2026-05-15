import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getForemanPaths } from "../utils/config.js";

export const STEPS = [
  "welcome",
  "secrets",
  "agents",
  "install",
  "policy",
  "done",
] as const;
export type Step = (typeof STEPS)[number];

export interface SetupState {
  version: 1;
  completed: Step[];
  startedAt: number;
  lastUpdatedAt: number;
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
    return raw;
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
