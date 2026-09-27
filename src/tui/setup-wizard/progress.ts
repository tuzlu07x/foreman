import type { Step } from "../setup-state.js";
import { WELCOME_STEPS } from "./welcome.js";

// Which Welcome-screen step each wizard step is part of. Every screen's
// progress bar is derived from WELCOME_STEPS through this map, so the
// numbers always agree with the preview the user saw on the Welcome screen.
// (They used to be hardcoded per screen and drifted: "Step 2 of 4 ▸ Agents"
// next to "Step 2 of 5 ▸ Foreman's brain".)
const WELCOME_STEP_NAME: Record<Exclude<Step, "welcome" | "done">, string> = {
  providers: "LLM Providers",
  "foreman-llm": "Foreman's brain",
  agents: "Agents",
  services: "Services",
  "chat-primary": "Services",
  "required-setup": "Install + Verify",
  install: "Install + Verify",
};

export type ProgressStep = keyof typeof WELCOME_STEP_NAME;

/** `current` / `total` props for WizardProgress on a given step's screens. */
export function stepProgress(step: ProgressStep): {
  current: number;
  total: number;
} {
  const entry = WELCOME_STEPS.find((s) => s.name === WELCOME_STEP_NAME[step]);
  if (!entry) {
    throw new Error(`no Welcome step named "${WELCOME_STEP_NAME[step]}"`);
  }
  return { current: entry.number, total: WELCOME_STEPS.length };
}
