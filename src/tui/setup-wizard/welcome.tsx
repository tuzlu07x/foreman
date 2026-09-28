import { Box, Text } from "ink";
import type { Key } from "ink";
import type { JSX } from "react";
import { blockFallbackFrame } from "../components/mascot-frames.js";
import { theme } from "../theme.js";
import type { WizardContext } from "./context.js";

export interface WelcomeStep {
  number: number;
  name: string;
  estimateMinutes: number;
  optional?: boolean;
}

// Step preview rendered on the Welcome screen. Names must line up with
// the actual step labels in the rest of the wizard so the user's mental
// model from this screen matches what they see in Steps 1–6.
export const WELCOME_STEPS: WelcomeStep[] = [
  { number: 1, name: "LLM Providers", estimateMinutes: 2 },
  { number: 2, name: "Foreman's brain", estimateMinutes: 1 },
  { number: 3, name: "Agents", estimateMinutes: 2 },
  { number: 4, name: "Services", estimateMinutes: 1, optional: true },
  { number: 5, name: "Integrations", estimateMinutes: 1, optional: true },
  { number: 6, name: "Install + Verify", estimateMinutes: 3 },
];

export function totalEstimatedMinutes(
  steps: readonly WelcomeStep[] = WELCOME_STEPS,
): number {
  return steps.reduce((sum, s) => sum + s.estimateMinutes, 0);
}

// Welcome-screen mascot. Reuses the boot-time block-character frame
// (#365) so the wizard's first impression matches the post-boot
// dashboard the user sees seconds later. Static — no morph/blink — to
// keep the welcome screen quiet. Only on wide terminals (>= 120 cols):
// at 80 columns it squeezed the text past the edge, and the screen grew
// taller than 24 rows, so its top stayed on screen under later steps.
const WELCOME_MASCOT = blockFallbackFrame(false).lines;
/** Long lines are hard to read on a very wide terminal. */
const WELCOME_TEXT_MAX = 90;

// ---------------- Welcome ----------------
export function renderWelcomeStep(ctx: WizardContext): JSX.Element {
  const { welcomeLayout } = ctx;
  const total = totalEstimatedMinutes();
  const stepList = (
    <Box flexDirection="column">
      <Text bold color={theme.accent.primary}>
        Welcome to Foreman
      </Text>
      <Text color={theme.fg.muted}>
        Foreman guards the AI agents on this machine (Claude Code, Codex,
        Hermes and others): every tool call is checked against your
        policy, risky ones wait for your OK, and everything lands in one
        audit trail. Chat apps like Telegram are optional.
      </Text>
      <Text color={theme.fg.muted}>
        You'll paste LLM provider keys, pick agents to install, and
        optionally set up Foreman's own AI brain for smarter routing.
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.fg.default}>
          We'll wire this up in {WELCOME_STEPS.length} steps:
        </Text>
        {WELCOME_STEPS.map((s) => (
          <Text key={s.number} color={theme.fg.muted}>
            {"  "}
            {s.number}. {s.name.padEnd(18, " ")}~{s.estimateMinutes} min
            {s.optional ? "  (optional)" : ""}
          </Text>
        ))}
        <Text color={theme.fg.muted}>
          {"  "}Total time: about {total} minutes.
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.fg.muted}>
          Quit any time with Ctrl-C (except while agents are installing) and
          resume with `foreman setup --resume`.
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>[Enter] Start setup     [q] Quit</Text>
      </Box>
    </Box>
  );
  if (welcomeLayout !== "wide") {
    return (
      <Box paddingY={1} flexDirection="column">
        {stepList}
      </Box>
    );
  }
  return (
    <Box paddingY={1}>
      <Box flexDirection="column" marginRight={2} flexShrink={0}>
        {WELCOME_MASCOT.map((row, i) => (
          <Text key={i} color={theme.accent.primary}>
            {row}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" flexShrink={1} width={WELCOME_TEXT_MAX}>
        {stepList}
      </Box>
    </Box>
  );
}

export function handleWelcomeInput(
  ctx: WizardContext,
  input: string,
  key: Key,
): boolean {
  const { quit, currentStep, advance } = ctx;
  if (currentStep === "welcome") {
    if (key.return) {
      advance("welcome");
      return true;
    }
    if (input === "q") {
      quit();
      return true;
    }
    // Esc on welcome: defer to the user. We don't auto-exit because the
    // user might be exploring; a deliberate `q` is the affordance.
    return true;
  }
  return false;
}
