import { Box, Text } from "ink";
import type { Key } from "ink";
import { type JSX, useEffect, useRef } from "react";
import { WizardProgress } from "../components/wizard-progress.js";
import { classifyInstallLog } from "../install-log-classify.js";
import { singleBorder, theme } from "../theme.js";
import { computeAgentDiff } from "./agents-logic.js";
import type { WizardContext } from "./context.js";
import { stepProgress } from "./progress.js";
import { runInstallStep } from "./install-runner.js";
import { installQuitNoticeText } from "./quit.js";
import type {
  AgentInstallFailure,
  FailureResolution,
  InstallStepSummary,
} from "./types.js";

// #459 — Braille spinner frames used by the install step. 10-frame rotation
// at 80ms = 8 frames/sec — matches the snappy boot-mascot vibe.
const BRAILLE_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

// #459 — Install UX. The render path collapses raw upstream installer
// output into a single spinner + milestone line; this state powers the
// spinner animation and elapsed-time display. `installStartedAt` is set
// when the install actually fires, not at component mount, so the timer
// matches what the user sees.
export function useInstallSpinner(ctx: WizardContext): void {
  const { installRunning, installSummary, installStartedAt } = ctx.state;
  const { setSpinnerFrame } = ctx.set;
  useEffect(() => {
    if (!installRunning || installSummary || !installStartedAt) return;
    const interval = setInterval(() => {
      setSpinnerFrame((f) => f + 1);
    }, 80);
    return () => clearInterval(interval);
  }, [installRunning, installSummary, installStartedAt]);
}

/** Summary for an install whose runner threw: nothing is known to have
 *  succeeded, so every agent it was adding counts as failed. */
export function failedInstallSummary(toAdd: string[]): InstallStepSummary {
  return {
    registered: [],
    identityPushed: [],
    identitySkipped: [],
    identityNotApplicable: [],
    failed: [...toAdd],
    removed: [],
    mcpRegisterFailed: [],
    nodeEngineSkipped: [],
    tokenToWire: [],
  };
}

// Starts the install once, when the wizard reaches the install step. It
// used to start from inside render (guarded by `installRunning`), a side
// effect React is free to repeat or discard. The ref guard keeps it to one
// start even if the effect is ever re-run (e.g. React's dev-only StrictMode
// effect remount).
export function useInstallKickoff(ctx: WizardContext): void {
  const {
    services,
    currentStep,
    advance,
    initialRegistered,
    failureResolverRef,
  } = ctx;
  const {
    providersSelected,
    agentsSelected,
    agentConfigs,
    servicesSelected,
  } = ctx.state;
  const {
    setInstallLog,
    setInstallRunning,
    setInstallSummary,
    setPendingFailure,
    setInstallStartedAt,
    setInstallSettled,
  } = ctx.set;
  const started = useRef(false);
  useEffect(() => {
    if (currentStep !== "install" || started.current) return;
    started.current = true;
    setInstallRunning(true);
    setInstallStartedAt(Date.now());
    const { toAdd, toRemove } = computeAgentDiff(
      agentsSelected,
      initialRegistered,
    );
    // Surface what's about to happen so the user catches a missed Space toggle
    // (e.g. wanted openclaw but never selected it) before install starts.
    setInstallLog(
      [
        `Selected agents: ${agentsSelected.length > 0 ? agentsSelected.join(", ") : "(none)"}`,
        ...(toAdd.length > 0
          ? [`▸ Will install: ${toAdd.join(", ")}`]
          : []),
        ...(toRemove.length > 0
          ? [`▸ Will remove: ${toRemove.join(", ")}`]
          : []),
        toAdd.length === 0 && toRemove.length === 0
          ? "▸ No changes — every selection is already registered."
          : "",
      ].filter(Boolean),
    );
    const onFailure = (
      failure: AgentInstallFailure,
    ): Promise<FailureResolution> => {
      setPendingFailure(failure);
      return new Promise<FailureResolution>((resolveResolution) => {
        failureResolverRef.current = resolveResolution;
      });
    };
    void runInstallStep(
      toAdd,
      toRemove,
      services,
      (line) => setInstallLog((prev) => [...prev, line]),
      agentConfigs,
      onFailure,
      { providersSelected, servicesSelected },
    ).then(
      (summary) => {
        setInstallSettled(true);
        setInstallSummary(summary);
        advance("install");
      },
      (err: unknown) => {
        // A runner that throws used to leave the wizard stuck on this
        // screen (and the rejection unhandled). Record every agent as
        // failed, keep the reason in the install log, and move on to Done.
        const reason = err instanceof Error ? err.message : String(err);
        setInstallLog((prev) => [...prev, `✗ install step failed: ${reason}`]);
        setInstallSettled(true);
        setInstallSummary(failedInstallSummary(toAdd));
        advance("install");
      },
    );
    // Runs once per wizard; the step's inputs are fixed by the time it
    // starts (back-navigation is disabled during install).
  }, [currentStep]);
}

export function handleInstallFailureInput(
  ctx: WizardContext,
  input: string,
  key: Key,
): boolean {
  const { failureResolverRef } = ctx;
  const { pendingFailure, manualFixOpen } = ctx.state;
  const { setPendingFailure, setManualFixOpen } = ctx.set;
  // Install-failure prompt (#177). When pendingFailure is set, runInstall
  // is awaiting a resolution — [r] retry, [s] skip, [m] open manual-fix
  // overlay. Esc on the overlay just closes it (re-shows the prompt).
  if (pendingFailure) {
    if (manualFixOpen) {
      if (key.escape) setManualFixOpen(false);
      return true;
    }
    if (input === "r") {
      failureResolverRef.current?.("retry");
      failureResolverRef.current = null;
      setPendingFailure(null);
      return true;
    }
    if (input === "s") {
      failureResolverRef.current?.("skip");
      failureResolverRef.current = null;
      setPendingFailure(null);
      return true;
    }
    if (input === "m") {
      setManualFixOpen(true);
      return true;
    }
    return true;
  }
  return false;
}

// ---------------- Install ----------------
export function renderInstallStep(ctx: WizardContext): JSX.Element {
  const {
    installLog,
    installRunning,
    installSummary,
    pendingFailure,
    installStartedAt,
    spinnerFrame,
    manualFixOpen,
    installQuitNotice,
  } = ctx.state;
  // #459 — Render path. Split the streamed log into Foreman's own
  // headline markers (✓/✗/⚠/▸) + a single rotating milestone line
  // sourced from the upstream installer chatter. On error
  // (pendingFailure) we flip back to verbose so the user can see the
  // actual failure context. Full log stays available via the Done
  // screen's [l] hotkey.
  const classified = classifyInstallLog(installLog);
  const verboseMode = pendingFailure !== null;
  const spinnerChar =
    BRAILLE_SPINNER_FRAMES[spinnerFrame % BRAILLE_SPINNER_FRAMES.length]!;
  const elapsedMs = installStartedAt ? Date.now() - installStartedAt : 0;
  return (
    <Box flexDirection="column" gap={1} paddingY={1}>
      <WizardProgress
        {...stepProgress("install")}
        label="Install + configure"
        phase={installRunning ? "running" : "ready"}
      />
      {verboseMode ? (
        installLog.map((line, i) => {
          const isError = line.trimStart().startsWith("✗");
          const isWarning = line.trimStart().startsWith("⚠");
          const color = isError
            ? theme.accent.danger
            : isWarning
              ? theme.accent.warning
              : undefined;
          return (
            <Text key={i} color={color}>
              {line}
            </Text>
          );
        })
      ) : (
        <Box flexDirection="column">
          {classified.headlines.map((line, i) => {
            const isError = line.trimStart().startsWith("✗");
            const isWarning = line.trimStart().startsWith("⚠");
            const color = isError
              ? theme.accent.danger
              : isWarning
                ? theme.accent.warning
                : undefined;
            return (
              <Text key={i} color={color}>
                {line}
              </Text>
            );
          })}
          {installRunning && !installSummary ? (
            <Box flexDirection="row">
              <Text color={theme.accent.primary} bold>
                {`  ${spinnerChar} `}
              </Text>
              <Text color={theme.fg.muted}>
                {classified.currentAgentName
                  ? `installing ${classified.currentAgentName}… ${formatElapsed(elapsedMs)}  `
                  : `installing… ${formatElapsed(elapsedMs)}  `}
              </Text>
              <Text color={theme.fg.muted}>
                {classified.lastMilestone ?? "preparing"}
              </Text>
            </Box>
          ) : null}
          {classified.verboseLineCount > 0 ? (
            <Text color={theme.fg.muted}>
              {`  (${classified.verboseLineCount} verbose line${classified.verboseLineCount === 1 ? "" : "s"} collapsed — press [l] later for full log)`}
            </Text>
          ) : null}
        </Box>
      )}
      {pendingFailure && !manualFixOpen && (
        <Box
          flexDirection="column"
          marginTop={1}
          paddingX={1}
          borderStyle={singleBorder()}
          borderColor={theme.accent.danger}
        >
          <Text bold color={theme.accent.danger}>
            ✗ {pendingFailure.agentName} — {pendingFailure.stage} failed
          </Text>
          <Text color={theme.fg.muted}>{pendingFailure.error}</Text>
          <Text color={theme.fg.muted}>
            [r] retry · [s] skip this agent · [m] manual fix instructions
          </Text>
        </Box>
      )}
      {pendingFailure && manualFixOpen && (
        <Box
          flexDirection="column"
          marginTop={1}
          paddingX={1}
          borderStyle={singleBorder()}
          borderColor={theme.accent.warning}
        >
          <Text bold color={theme.accent.warning}>
            Manual fix — {pendingFailure.agentName}
          </Text>
          <Text>{pendingFailure.manualHint}</Text>
          <Text color={theme.fg.muted}>
            [Esc] back to the retry / skip prompt
          </Text>
        </Box>
      )}
      {!pendingFailure && (
        <Text color={theme.fg.muted}>
          (install running — back-navigation disabled mid-flight)
        </Text>
      )}
      {installQuitNotice ? (
        <Text color={theme.accent.warning}>
          {installQuitNoticeText(pendingFailure !== null)}
        </Text>
      ) : null}
    </Box>
  );
}
