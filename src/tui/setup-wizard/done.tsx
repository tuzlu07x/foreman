import { existsSync, readFileSync } from "node:fs";
import { StatusMessage } from "@inkjs/ui";
import { Box, Text } from "ink";
import type { Key } from "ink";
import type { JSX } from "react";
import { parse as parseYaml } from "yaml";
import { runDoctor } from "../../core/doctor.js";
import type { LlmPreset } from "../../core/llm-provider-presets.js";
import {
  loadActiveRegistry,
  type AgentEntry,
} from "../../core/registry-catalog.js";
import { theme } from "../theme.js";
import type { WizardContext } from "./context.js";
import {
  configuredProviderIds,
  configuredServiceIds,
  safeFind,
} from "./shared.js";
import type { WizardOauthRunStep } from "./types.js";

export function handleDoneInput(
  ctx: WizardContext,
  input: string,
  key: Key,
): boolean {
  const { services, exit, currentStep, requiredSetupResolution } = ctx;
  const { providersSignedIn, donePhase } = ctx.state;
  const { setDonePhase, setDoctorReport } = ctx.set;
  if (currentStep === "done" && donePhase === "main") {
    const mandatoryOauthSteps = requiredSetupResolution.oauthSteps.filter(
      (o) => o.mandatory,
    );
    const allOauthSteps = requiredSetupResolution.oauthSteps;
    // Faz 4b-3 / #512 — for every provider the user picked subscription
    // sign-in on in the providers step, queue a `foreman llm login` to
    // run with the rest of the OAuth flows. Treated as mandatory because
    // the user explicitly opted in; without running it `auth_mode: oauth`
    // is set but no tokens exist and the first call errors with
    // LlmOAuthLoginRequiredError.
    const foremanLlmOauthSteps: WizardOauthRunStep[] =
      providersSignedIn.map((pid) => ({
        agentId: "foreman-llm",
        command: `foreman llm login ${pid}`,
        verify: null,
        mandatory: true,
        reason: `Sign in to ${pid} so Foreman LLM uses your subscription`,
      }));
    // QA round 4 — mandatory OAuth (Codex/oauth, Hermes/via-codex-oauth,
    // Claude Code/oauth) is the SOLE auth path for its agent. If the
    // user just presses [Enter] expecting setup to finish, we still
    // need to fire those commands or the agent won't be reachable.
    // [Enter] now auto-runs mandatory steps + exits; [y] runs ALL
    // (mandatory + optional like `hermes model`); [q] is the only
    // skip path.
    if (key.return) {
      const mandatorySteps: WizardOauthRunStep[] = [
        ...mandatoryOauthSteps.map((s) => ({
          agentId: s.agentId,
          command: s.command,
          verify: s.verify,
          mandatory: s.mandatory,
          reason: s.reason,
        })),
        ...foremanLlmOauthSteps,
      ];
      if (mandatorySteps.length > 0) {
        services.requestOauthRun?.(mandatorySteps);
      }
      exit();
      return true;
    }
    if (input === "d") {
      setDoctorReport(runDoctor());
      setDonePhase("doctor");
      return true;
    }
    if (input === "p") {
      void services.launchEditor(services.policyPath);
      return true;
    }
    if (input === "l") {
      setDonePhase("log");
      return true;
    }
    // #468 — Hand off the queued OAuth/interactive_setup commands to
    // the outer CLI which runs them with inherited stdio so the
    // browser-OAuth flow actually works. Exit cleanly afterwards;
    // re-running `foreman doctor` confirms the final state.
    if (
      input === "y" &&
      (allOauthSteps.length > 0 || foremanLlmOauthSteps.length > 0)
    ) {
      const steps: WizardOauthRunStep[] = [
        ...allOauthSteps.map((s) => ({
          agentId: s.agentId,
          command: s.command,
          verify: s.verify,
          mandatory: s.mandatory,
          reason: s.reason,
        })),
        ...foremanLlmOauthSteps,
      ];
      services.requestOauthRun?.(steps);
      exit();
      return true;
    }
    if (input === "q") {
      // Quit without launching the gateway. exec'ing process.exit instead
      // of exit() so the parent runOnboardingWizard's caller (start.ts)
      // never reaches startForeman().
      process.exit(0);
    }
  }

  if (
    currentStep === "done" &&
    (donePhase === "doctor" || donePhase === "log")
  ) {
    // #381 — accept multiple back keys so the user isn't stuck if Esc
    // misfires (some terminals translate Esc to multi-byte sequences
    // that Ink doesn't surface as key.escape). Round-3 user got trapped
    // on the doctor sub-page until they ^C the wizard.
    if (key.escape || key.return || input === "b" || input === "q") {
      setDonePhase("main");
      return true;
    }
  }
  return false;
}

export function renderDoneStep(ctx: WizardContext): JSX.Element {
  const {
    services,
    afterExit,
    providerCatalog,
    serviceCatalog,
    llmPresetDoc,
    requiredSetupResolution,
  } = ctx;
  const {
    providersSignedIn,
    installLog,
    installSummary,
    donePhase,
    doctorReport,
  } = ctx.state;
  // ---------------- Policy ----------------
  // ---------------- Done ----------------
  // Policy review used to be its own labelless step here; it's now reachable
  // via the Done screen's [p] hotkey (#178), so STEPS no longer carries
  // "policy" and the dedicated render block is gone (#155).
  const storedNames = new Set(
    services.secretStore.list().map((s) => s.name),
  );
  // Presets (Foreman's brain → OpenAI-compatible) keep their key in their
  // own slot, which the provider catalog doesn't know about.
  const providerIds = [
    ...configuredProviderIds(providerCatalog, storedNames),
    ...configuredPresetIds(llmPresetDoc.presets, storedNames),
  ];
  const serviceIds = configuredServiceIds(serviceCatalog, storedNames);
  const agentRows = services.registry.list();
  const policyRuleCount = countPolicyRules(services.policyPath);
  // Agents without an identity file (generic-mcp) aren't push targets.
  const identityTargets = installSummary
    ? installSummary.registered.length -
      installSummary.identityNotApplicable.length
    : 0;

  if (donePhase === "doctor" && doctorReport) {
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold color={theme.accent.primary}>
          foreman doctor
        </Text>
        {/* Problems in full, passing checks on one line: the whole list
            (27+ rows, one blank line between each) scrolled off a 24-row
            terminal (#657). `foreman doctor` prints every row. */}
        <Box flexDirection="column">
          {(() => {
            const passed = doctorReport.checks.filter((c) => c.status === "ok");
            return passed.length > 0 ? (
              <Text color={theme.accent.success} wrap="truncate-end">
                {"  "}✓ {passed.length} ok: {passed.map((c) => c.name).join(", ")}
              </Text>
            ) : null;
          })()}
          {doctorReport.checks
            .filter((c) => c.status !== "ok")
            .map((c) => (
              <Text
                key={c.name}
                color={c.status === "warn" ? theme.accent.warning : theme.accent.danger}
              >
                {"  "}
                {c.status === "warn" ? "⚠" : "✗"} {c.name}: {c.message}
              </Text>
            ))}
        </Box>
        <Text color={theme.fg.muted}>
          (exit code {doctorReport.exitCode}) — [Esc] / [Enter] / [b] back
        </Text>
      </Box>
    );
  }

  if (donePhase === "log") {
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold color={theme.accent.primary}>
          Install log
        </Text>
        <Box flexDirection="column">
        {installLog.map((line, i) => {
          const trimmed = line.trimStart();
          const color = trimmed.startsWith("✗")
            ? theme.accent.danger
            : trimmed.startsWith("⚠")
              ? theme.accent.warning
              : undefined;
          return (
            <Text key={i} color={color}>
              {line}
            </Text>
          );
        })}
        </Box>
        <Text color={theme.fg.muted}>[Esc] / [Enter] / [b] back</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1} paddingY={1}>
      <StatusMessage variant="success">
        Setup complete — Foreman is ready to guard your agents.
      </StatusMessage>
      <Box flexDirection="column">
        <Text bold>Summary</Text>
        <Text color={theme.fg.muted}>
          {"  "}
          {providerIds.length} LLM provider
          {providerIds.length === 1 ? "" : "s"}
          {providerIds.length > 0 ? `   ${providerIds.join(", ")}` : ""}
        </Text>
        <Text color={theme.fg.muted}>
          {"  "}
          {agentRows.length} agent{agentRows.length === 1 ? "" : "s"}
          {agentRows.length > 0
            ? `         ${agentRows.map((a) => a.id).join(", ")}`
            : ""}
        </Text>
        <Text color={theme.fg.muted}>
          {"  "}
          {serviceIds.length} service{serviceIds.length === 1 ? "" : "s"}
          {serviceIds.length > 0 ? `       ${serviceIds.join(", ")}` : ""}
        </Text>
        <Text color={theme.fg.muted}>
          {"  "}
          {policyRuleCount} policy rule
          {policyRuleCount === 1 ? "" : "s"}   smart defaults active
        </Text>
      </Box>
      {installSummary && (
        <Box flexDirection="column">
          {identityTargets > 0 ? (
            <Text color={theme.fg.muted}>
              Foreman identity pushed to{" "}
              {installSummary.identityPushed.length} of {identityTargets} agent
              {identityTargets === 1 ? "" : "s"}
              {installSummary.identitySkipped.length > 0
                ? ` (${installSummary.identitySkipped.length} skipped)`
                : ""}
              .
            </Text>
          ) : null}
          {installSummary.identityNotApplicable.length > 0 ? (
            <Text color={theme.fg.muted}>
              No Foreman identity file for{" "}
              {installSummary.identityNotApplicable.join(", ")} (nothing to
              push).
            </Text>
          ) : null}
          {/* #472 — Name the agents whose identity push failed + the
              underlying reason. Previously the count masked which agent
              broke, so the user had no path forward when the Telegram
              flow later said "Provider authentication failed". */}
          {installSummary.identitySkipped.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.accent.warning} bold>
                ⚠ Identity push failed for these agents:
              </Text>
              {installSummary.identitySkipped.map((s) => (
                <Box key={s.agentId} flexDirection="column" marginLeft={2}>
                  <Text color={theme.accent.warning}>
                    ✗ {s.agentId}
                  </Text>
                  <Text color={theme.fg.muted}>
                    {"    "}{s.reason}
                  </Text>
                  <Text color={theme.fg.muted}>
                    {"    "}retry: foreman doctor — diagnoses + suggests fix
                  </Text>
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      )}
      {/* #audit-finding-15 — Agents that registered but whose Foreman
          MCP registration failed are functional for chat but can't call
          Foreman tools. Without surfacing the failure on Done the user
          assumes everything's wired and only sees the gap when an agent
          tries (and fails) to invoke a Foreman MCP tool. */}
      {installSummary && installSummary.mcpRegisterFailed.length > 0 && (
        <Box flexDirection="column">
          <Text bold color={theme.accent.warning}>
            ⚠ Foreman MCP registration failed for these agents:
          </Text>
          {installSummary.mcpRegisterFailed.map((f) => (
            <Box key={f.agentId} flexDirection="column" marginLeft={2}>
              <Text color={theme.accent.warning}>✗ {f.agentId}</Text>
              <Text color={theme.fg.muted}>{"    "}{f.reason}</Text>
              <Text color={theme.fg.muted}>{"    "}retry: {f.command}</Text>
            </Box>
          ))}
          <Text color={theme.fg.muted}>
            These agents will run but can't call Foreman tools until the
            command above succeeds.
          </Text>
        </Box>
      )}
      {/* #618 — Agents with a token Foreman had nowhere to write (no MCP
          config in the registry) run untrusted until it is wired by hand.
          Name the command that fetches it; never the token. */}
      {installSummary && installSummary.tokenToWire.length > 0 && (
        <Box flexDirection="column">
          <Text bold color={theme.accent.warning}>
            ⚠ Wire these agents' identity tokens by hand:
          </Text>
          {installSummary.tokenToWire.map((id) => (
            <Box key={id} flexDirection="column" marginLeft={2}>
              <Text color={theme.accent.warning}>▸ {id}</Text>
              <Text color={theme.fg.muted}>
                {"    "}foreman agent rewire {id} --token-out {"<file>"}
              </Text>
            </Box>
          ))}
          <Text color={theme.fg.muted}>
            Set the file's token as FOREMAN_AGENT_TOKEN (or point
            FOREMAN_AGENT_TOKEN_FILE at the file) in the agent's MCP server
            env; without it the agent's calls run untrusted.
          </Text>
        </Box>
      )}
      {/* #646 — The install screen advances to Done on its own, so an
          agent held back by its Node range would otherwise only appear in
          a log the user never saw. Repeat the requirement and the
          upstream installer command here. */}
      {installSummary && installSummary.nodeEngineSkipped.length > 0 && (
        <Box flexDirection="column">
          <Text bold color={theme.accent.warning}>
            ⚠ Not installed: these agents need a newer Node.js
          </Text>
          {installSummary.nodeEngineSkipped.map((s) => (
            <Box key={s.agentId} flexDirection="column" marginLeft={2}>
              <Text color={theme.accent.warning}>✗ {s.agentId}</Text>
              {s.lines.map((line) => (
                <Text key={line} color={theme.fg.muted}>
                  {"    "}
                  {line}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      )}
      {installSummary && installSummary.registered.length > 0 && (
        <LaunchCommands agentIds={installSummary.registered} />
      )}
      {/* #408 / #411 Phase 3 — surface queued OAuth flows that the user
          accepted to run manually. Without this hint the wizard would
          leave Codex / Claude Code in an un-authenticated state and the
          user wouldn't know which command to run. #461 splits mandatory
          cross-agent OAuth dependencies into a separate must-do block;
          skipping those leaves the agent unable to talk to its provider
          (silent failure on first message). */}
      {requiredSetupResolution.oauthSteps.filter((o) => o.mandatory).length > 0 && (
        <Box flexDirection="column">
          <Text bold color={theme.accent.warning}>
            ⚠ Mandatory — these MUST run before the agent can reach its
            provider
          </Text>
          {requiredSetupResolution.oauthSteps
            .filter((o) => o.mandatory)
            .map((o) => (
              <Box
                key={`${o.agentId}-${o.command}`}
                flexDirection="column"
                marginLeft={2}
              >
                <Box flexDirection="row">
                  <Text color={theme.accent.warning}>▸ {o.command}</Text>
                  <Text color={theme.fg.muted}>
                    {"  "}({o.agentId}
                    {o.verify ? ` · verify: ${o.verify}` : ""})
                  </Text>
                </Box>
                {o.reason ? (
                  <Text color={theme.fg.muted}>{"  "}{o.reason}</Text>
                ) : null}
              </Box>
            ))}
        </Box>
      )}
      {requiredSetupResolution.oauthSteps.filter((o) => !o.mandatory).length > 0 && (
        <Box flexDirection="column">
          <Text bold>Run these to finish OAuth setup</Text>
          {requiredSetupResolution.oauthSteps
            .filter((o) => !o.mandatory)
            .map((o) => (
              <Box
                key={`${o.agentId}-${o.command}`}
                flexDirection="row"
                marginLeft={2}
              >
                <Text color={theme.accent.primary}>▸ {o.command}</Text>
                <Text color={theme.fg.muted}>
                  {"  "}({o.agentId}
                  {o.verify ? ` · verify: ${o.verify}` : ""})
                </Text>
              </Box>
            ))}
        </Box>
      )}
      {providersSignedIn.length > 0 && (
        <Box flexDirection="column">
          <Text bold color={theme.accent.warning}>
            ⚿ Foreman LLM sign-in — opens your browser
          </Text>
          {providersSignedIn.map((pid) => (
            <Box
              key={`foreman-llm-signin:${pid}`}
              flexDirection="column"
              marginLeft={2}
            >
              <Text color={theme.accent.warning}>
                ▸ foreman llm login {pid}
              </Text>
              <Text color={theme.fg.muted}>
                {"  "}sign in to {pid} with your subscription
              </Text>
            </Box>
          ))}
        </Box>
      )}
      <Box flexDirection="column">
        <Text bold>What next?</Text>
        {(() => {
          const mandatoryCount =
            requiredSetupResolution.oauthSteps.filter((o) => o.mandatory).length +
            providersSignedIn.length;
          if (mandatoryCount > 0) {
            // Same host rule as below: under `foreman start` the sign-ins
            // run and then the TUI launches; `foreman setup` just exits.
            return (
              <Text color={theme.accent.warning}>
                {"  "}[Enter] Run mandatory OAuth ({mandatoryCount} step
                {mandatoryCount === 1 ? "" : "s"})
                {afterExit === "launch-tui"
                  ? ", then launch Foreman TUI"
                  : " + exit"}
              </Text>
            );
          }
          // Only `foreman start` opens the TUI after the wizard exits;
          // under `foreman setup` Enter just finishes (#621 follow-up).
          return (
            <Text color={theme.fg.muted}>
              {afterExit === "launch-tui"
                ? "  [Enter] Launch Foreman TUI"
                : "  [Enter] Finish setup — start Foreman later with `foreman start`"}
            </Text>
          );
        })()}
        {requiredSetupResolution.oauthSteps.length > 0 ||
        providersSignedIn.length > 0 ? (
          <Text color={theme.fg.muted}>
            {"  "}[y]     Run ALL OAuth steps now (incl. optional)
          </Text>
        ) : null}
        <Text color={theme.fg.muted}>{"  "}[d]     Run foreman doctor</Text>
        <Text color={theme.fg.muted}>
          {"  "}[p]     Review policy file
        </Text>
        <Text color={theme.fg.muted}>{"  "}[l]     Show install log</Text>
        <Text color={theme.fg.muted}>
          {"  "}[q]     Exit
          {requiredSetupResolution.oauthSteps.length > 0 || providersSignedIn.length > 0
            ? " (skip OAuth)"
            : ""}
        </Text>
      </Box>
    </Box>
  );
}

// Read the policy.yaml rule count without instantiating a PolicyEngine.
// Returns 0 on missing / malformed file rather than throwing — the Done
// screen is best-effort reporting, not the canonical policy validator.
/** Ids of the OpenAI-compatible presets whose API key is stored. */
export function configuredPresetIds(
  presets: readonly LlmPreset[],
  storedNames: Set<string>,
): string[] {
  return presets
    .filter((p) => storedNames.has(p.key_secret_name))
    .map((p) => p.id);
}

export function countPolicyRules(policyPath: string): number {
  if (!existsSync(policyPath)) return 0;
  try {
    const parsed = parseYaml(readFileSync(policyPath, "utf-8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "rules" in parsed &&
      Array.isArray((parsed as { rules: unknown[] }).rules)
    ) {
      return (parsed as { rules: unknown[] }).rules.length;
    }
    return 0;
  } catch {
    return 0;
  }
}

// Done-screen tile that lists how to start each newly-installed agent. Driven
// by `secret_projection.launch` in the registry — single string OR array of
// {command, label} (Hermes chat vs gateway, OpenClaw chat vs gateway).
function LaunchCommands({ agentIds }: { agentIds: string[] }): JSX.Element | null {
  const { doc } = loadActiveRegistry();
  const rows = agentIds
    .map((id) => safeFind(doc, id))
    .filter((e): e is AgentEntry => e !== null)
    .filter((e) => e.secret_projection?.launch !== undefined);
  if (rows.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text bold>Launch your agents</Text>
      {rows.map((entry) => {
        const launch = entry.secret_projection!.launch!;
        const commands = typeof launch === "string"
          ? [{ command: launch, label: "" }]
          : launch;
        return (
          <Box flexDirection="column" key={entry.id} marginLeft={2}>
            <Text>
              <Text color={theme.accent.primary}>▸ {entry.name}</Text>
            </Text>
            {commands.map((c, i) => (
              <Text key={`${entry.id}-${i}`}>
                {"    "}
                <Text color={theme.accent.primary}>{c.command}</Text>
                {c.label ? (
                  <Text color={theme.fg.muted}>{`  (${c.label})`}</Text>
                ) : null}
              </Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
