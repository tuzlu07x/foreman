import { Box, Text } from "ink";
import { theme } from "../theme.js";

// =============================================================================
// Wizard step indicator (#234 UX-9)
// =============================================================================
//
// Renders a chunky progress bar + breadcrumb at the top of each wizard step:
//
//   [████░░░░░░░░░░] Step 2 of 4 ▸ Agents ▸ pick which to install
//
// The bar's filled portion = (currentStep / totalSteps), padded so it visually
// shows where the user is in the flow. Optional `phase` breadcrumb tail is
// for sub-screens within a step (e.g. "value 1 of 2", "summary", "confirm").

export interface WizardProgressProps {
  /** 1-indexed step number. */
  current: number;
  /** Total steps in the flow (usually 4). */
  total: number;
  /** Step's main label — "LLM Providers", "Agents", "Services", "Install". */
  label: string;
  /** Optional sub-screen breadcrumb tail. */
  phase?: string;
}

export function WizardProgress({
  current,
  total,
  label,
  phase,
}: WizardProgressProps): JSX.Element {
  const safeCurrent = Math.max(0, Math.min(total, current));
  const filled = Math.max(0, Math.min(total, safeCurrent));
  const bar = "█".repeat(filled) + "░".repeat(Math.max(0, total - filled));
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.accent.primary}>[{bar}]</Text>{" "}
        <Text color={theme.fg.muted}>
          Step {safeCurrent} of {total}
        </Text>{" "}
        <Text color={theme.fg.muted}>{theme.symbols.bullet}</Text>{" "}
        <Text bold color={theme.fg.emphasis}>
          {label}
        </Text>
        {phase ? (
          <>
            <Text color={theme.fg.muted}>{` ${theme.symbols.bullet} `}</Text>
            <Text color={theme.fg.muted}>{phase}</Text>
          </>
        ) : null}
      </Text>
    </Box>
  );
}

// Map step ids to labels used across the wizard. Keeps the headings honest:
// changing here propagates everywhere.
export const WIZARD_STEPS = [
  { id: "providers", label: "LLM Providers" },
  { id: "agents", label: "Agents" },
  { id: "services", label: "Services" },
  { id: "install", label: "Install + configure" },
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]["id"];

export function stepNumber(id: WizardStepId): number {
  return WIZARD_STEPS.findIndex((s) => s.id === id) + 1;
}
