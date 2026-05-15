import { Box, Text, useApp } from "ink";
import {
  ConfirmInput,
  MultiSelect,
  PasswordInput,
  StatusMessage,
} from "@inkjs/ui";
import { useEffect, useMemo, useState } from "react";
import {
  checkSecrets,
  pickConfigPath,
  registerAgent,
} from "../core/agent-add-flow.js";
import {
  applyInjection,
  planInjection,
  UnsupportedConfigFormatError,
} from "../core/agent-config-injector.js";
import {
  detectInstall,
  preferredUninstallCommand,
  runInstall,
  runUninstall,
} from "../core/agent-install.js";
import { buildMcpSnippet } from "../core/agent-mcp-snippet.js";
import {
  findAgent,
  loadActiveRegistry,
  type AgentEntry,
} from "../core/registry-catalog.js";
import { applyForemanSoul } from "../core/foreman-soul.js";
import { RegistryService } from "../core/registry.js";
import { SecretStore } from "../core/secret-store.js";
import type { ForemanDb } from "../db/client.js";
import { getForemanPaths } from "../utils/config.js";
import {
  markCompleted,
  saveSetupState,
  type SetupState,
  type Step,
} from "./setup-state.js";
import { theme } from "./theme.js";

// Each secret entry carries a help URL so the wizard can tell the user where
// to grab the key from. Add new entries here when a new partner integration
// requires its own credential.
const COMMON_SECRETS = [
  {
    value: "anthropic-key",
    label: "Anthropic API key",
    helpUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    value: "openai-key",
    label: "OpenAI API key",
    helpUrl: "https://platform.openai.com/api-keys",
  },
  {
    value: "gemini-api-key",
    label: "Google Gemini API key",
    helpUrl: "https://aistudio.google.com/app/apikey",
  },
  {
    value: "telegram-bot-token",
    label: "Telegram bot token",
    helpUrl: "https://t.me/BotFather",
  },
  {
    value: "discord-bot-token",
    label: "Discord bot token",
    helpUrl: "https://discord.com/developers/applications",
  },
];

// Pre-checked secrets on fresh install — the three any new user is most likely
// to want. They can Space-toggle off the ones they don't need; pressing Enter
// on the default lands them straight on the PasswordInput for each.
const DEFAULT_SECRETS = [
  "anthropic-key",
  "openai-key",
  "telegram-bot-token",
];

const DEFAULT_AGENTS = ["hermes", "claude-code"];

export interface WizardServices {
  db: ForemanDb;
  secretStore: SecretStore;
  registry: RegistryService;
  policyPath: string;
  launchEditor: (path: string) => Promise<unknown>;
}

export interface SetupWizardProps {
  initialState: SetupState;
  services: WizardServices;
}

// Three-phase state machine for the Secrets step. Replaces the old single
// `secretsDone` flag — `secretsDone` made the picker and value-entry blocks
// overlap (both gated on `!secretsDone`), so the picker's early return made the
// value-entry block unreachable (#151).
export type SecretsPhase = "picker" | "values" | "summary";

export interface SecretsPickerSubmitResult {
  nextPhase: SecretsPhase;
  selected: string[];
}

export function applySecretsPickerSubmit(
  values: string[],
): SecretsPickerSubmitResult {
  if (values.length === 0) {
    return { nextPhase: "summary", selected: [] };
  }
  return { nextPhase: "values", selected: values };
}

export interface SecretsValueSubmitInput {
  name: string;
  value: string;
  currentIdx: number;
  totalSelected: number;
}

export interface SecretsValueSubmitResult {
  shouldSave: boolean;
  warning: string | null;
  nextPhase: SecretsPhase;
  nextIdx: number;
}

// Same phase-machine pattern as Secrets — the old `agentsDone` boolean made
// the picker drop straight into install with no confirmation step, so a
// silently-defaulted selection couldn't be caught before it ran (#152).
export type AgentsPhase = "picker" | "confirm" | "running";

export interface AgentsPickerSubmitResult {
  nextPhase: AgentsPhase;
  selected: string[];
}

export function applyAgentsPickerSubmit(
  values: string[],
): AgentsPickerSubmitResult {
  return { nextPhase: "confirm", selected: values };
}

export interface AgentDiff {
  toAdd: string[];
  toRemove: string[];
}

export function computeAgentDiff(
  selected: string[],
  initialRegistered: string[],
): AgentDiff {
  const toAdd = selected.filter((id) => !initialRegistered.includes(id));
  const toRemove = initialRegistered.filter((id) => !selected.includes(id));
  return { toAdd, toRemove };
}

export function applySecretsValueSubmit(
  input: SecretsValueSubmitInput,
): SecretsValueSubmitResult {
  const isLast = input.currentIdx + 1 >= input.totalSelected;
  if (input.value.length === 0) {
    return {
      shouldSave: false,
      warning: `Skipped ${input.name} — empty value. Add it later with 'foreman secrets add ${input.name}'.`,
      nextPhase: isLast ? "summary" : "values",
      nextIdx: input.currentIdx + 1,
    };
  }
  return {
    shouldSave: true,
    warning: null,
    nextPhase: isLast ? "summary" : "values",
    nextIdx: input.currentIdx + 1,
  };
}

export function SetupWizard({
  initialState,
  services,
}: SetupWizardProps): JSX.Element {
  const { exit } = useApp();
  const [state, setState] = useState<SetupState>(initialState);
  const currentStep: Step = useMemo(() => {
    for (const s of [
      "welcome",
      "secrets",
      "agents",
      "install",
      "policy",
      "done",
    ] as Step[]) {
      if (!state.completed.includes(s)) return s;
    }
    return "done";
  }, [state]);

  const advance = (step: Step): void => {
    setState((prev) => {
      const next = markCompleted(prev, step);
      saveSetupState(next);
      return next;
    });
  };

  const [secretsSelected, setSecretsSelected] = useState<string[]>([]);
  const [secretIdx, setSecretIdx] = useState(0);
  const [secretsPhase, setSecretsPhase] = useState<SecretsPhase>("picker");
  const [secretsSaved, setSecretsSaved] = useState<string[]>([]);
  const [secretsSkipped, setSecretsSkipped] = useState<string[]>([]);
  const [secretsWarning, setSecretsWarning] = useState<string | null>(null);

  // Agents already registered in this Foreman home — drive the wizard's
  // diff logic: still-checked = no-op or re-verify; newly-checked = install;
  // previously-checked-now-unchecked = uninstall + remove.
  const initialRegistered = useMemo(
    () => services.registry.list().map((a) => a.id),
    [services.registry],
  );
  const [agentsSelected, setAgentsSelected] = useState<string[]>(() =>
    initialRegistered.length > 0 ? initialRegistered : DEFAULT_AGENTS,
  );
  const [agentsPhase, setAgentsPhase] = useState<AgentsPhase>("picker");
  // Memoize the catalog so MultiSelect doesn't re-mount on every render —
  // re-mount would reset the user's toggles back to defaultValue (#152).
  const agentCatalog = useMemo(() => loadActiveRegistry().doc.agents, []);

  const [installLog, setInstallLog] = useState<string[]>([]);
  const [installRunning, setInstallRunning] = useState(false);

  const [policyReview, setPolicyReview] = useState(false);

  // ---------------- Welcome ----------------
  if (currentStep === "welcome") {
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold color={theme.accent.primary}>
          Foreman setup — 5 minutes to a working multi-agent workspace
        </Text>
        <Text color={theme.fg.muted}>
          We'll add API keys to the encrypted secret store, install the agents
          you want to wire up, inject the foreman MCP block into each agent's
          config, and review the safe-default policy.
        </Text>
        <Text>Continue? (y/n)</Text>
        <ConfirmInput
          onConfirm={() => advance("welcome")}
          onCancel={() => exit()}
        />
      </Box>
    );
  }

  // ---------------- Secrets — picker ----------------
  if (currentStep === "secrets" && secretsPhase === "picker") {
    const presentSecrets = DEFAULT_SECRETS.filter((s) =>
      services.secretStore.exists(s),
    );
    const defaults = DEFAULT_SECRETS.filter(
      (s) => !presentSecrets.includes(s),
    );
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold>Step 1 / 4 — API keys (selection)</Text>
        <Text color={theme.fg.muted}>
          ↑↓ move · <Text bold>Space toggle</Text> · Enter confirm. Foreman
          encrypts these on disk and hands them to agents on demand. Toggle off
          any you don't have yet; you can always come back via
          'foreman secrets add &lt;name&gt;'.
        </Text>
        <Text color={theme.accent.primary}>
          Pre-checked: {defaults.length > 0 ? defaults.join(", ") : "(none — all already stored)"}
        </Text>
        <MultiSelect
          options={COMMON_SECRETS}
          defaultValue={defaults}
          onSubmit={(values) => {
            const result = applySecretsPickerSubmit(values);
            setSecretsSelected(result.selected);
            setSecretIdx(0);
            setSecretsPhase(result.nextPhase);
          }}
        />
      </Box>
    );
  }

  // ---------------- Secrets — value prompts ----------------
  if (currentStep === "secrets" && secretsPhase === "values") {
    const name = secretsSelected[secretIdx];
    if (!name) {
      setSecretsPhase("summary");
      return <Text>…</Text>;
    }
    const helpUrl = COMMON_SECRETS.find((s) => s.value === name)?.helpUrl;
    const progress = `(${secretIdx + 1}/${secretsSelected.length})`;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold>
          Step 1 / 4 — API keys (value {secretIdx + 1} of{" "}
          {secretsSelected.length})
        </Text>
        <Text>
          {theme.symbols.bullet} Value for{" "}
          <Text bold color={theme.accent.primary}>
            {name}
          </Text>{" "}
          <Text color={theme.fg.muted}>{progress}</Text>
        </Text>
        {helpUrl && (
          <Text color={theme.fg.muted}>
            Get yours at: <Text color={theme.accent.primary}>{helpUrl}</Text>
          </Text>
        )}
        <Text color={theme.fg.muted}>
          (paste the value below — Enter to save · Enter on empty input to skip)
        </Text>
        {secretsWarning && (
          <Text color={theme.accent.warning}>⚠ {secretsWarning}</Text>
        )}
        <PasswordInput
          placeholder="…"
          onSubmit={(value) => {
            const result = applySecretsValueSubmit({
              name,
              value,
              currentIdx: secretIdx,
              totalSelected: secretsSelected.length,
            });
            if (result.shouldSave) {
              try {
                if (!services.secretStore.exists(name)) {
                  services.secretStore.add(name, value);
                } else {
                  services.secretStore.rotate(name, value);
                }
                setSecretsSaved((prev) => [...prev, name]);
              } catch (err) {
                setSecretsWarning(
                  `failed to store ${name}: ${err instanceof Error ? err.message : String(err)}`,
                );
                return;
              }
            } else {
              setSecretsSkipped((prev) => [...prev, name]);
            }
            setSecretsWarning(result.warning);
            setSecretIdx(result.nextIdx);
            setSecretsPhase(result.nextPhase);
          }}
        />
      </Box>
    );
  }

  // ---------------- Secrets — summary ----------------
  if (currentStep === "secrets" && secretsPhase === "summary") {
    const savedCount = secretsSaved.length;
    const skippedCount = secretsSkipped.length;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold>Step 1 / 4 — API keys (summary)</Text>
        {savedCount > 0 ? (
          <Box flexDirection="column">
            <Text color={theme.accent.success}>
              ✓ Saved {savedCount} secret{savedCount === 1 ? "" : "s"}:
            </Text>
            {secretsSaved.map((name) => (
              <Text key={name} color={theme.fg.muted}>
                {"  "}• {name}
              </Text>
            ))}
          </Box>
        ) : (
          <Text color={theme.fg.muted}>
            (no secrets stored — you can add them later with 'foreman secrets
            add &lt;name&gt;')
          </Text>
        )}
        {skippedCount > 0 && (
          <Box flexDirection="column">
            <Text color={theme.accent.warning}>
              ⚠ Skipped {skippedCount} (empty value):
            </Text>
            {secretsSkipped.map((name) => (
              <Text key={name} color={theme.fg.muted}>
                {"  "}• {name}
              </Text>
            ))}
          </Box>
        )}
        <Text>Continue to agents? (y/n)</Text>
        <ConfirmInput
          onConfirm={() => advance("secrets")}
          onCancel={() => advance("secrets")}
        />
      </Box>
    );
  }

  // ---------------- Agents — picker ----------------
  if (currentStep === "agents" && agentsPhase === "picker") {
    const options = agentCatalog.map((a) => ({
      value: a.id,
      label: initialRegistered.includes(a.id)
        ? `${a.name}  (installed) — ${a.tagline}`
        : `${a.name} — ${a.tagline}`,
    }));
    const defaults =
      initialRegistered.length > 0 ? initialRegistered : DEFAULT_AGENTS;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold>Step 2 / 4 — Agents (selection)</Text>
        <Text color={theme.fg.muted}>
          ↑↓ move · <Text bold>Space toggle</Text> · Enter confirm. Defaults
          are pre-checked — toggle off any you don't want, toggle on any you
          do. Newly-checked agents are installed; previously-installed agents
          you uncheck are uninstalled.
        </Text>
        <Text color={theme.accent.primary}>
          Pre-checked: {defaults.length > 0 ? defaults.join(", ") : "(none)"}
        </Text>
        <MultiSelect
          options={options}
          defaultValue={defaults}
          onSubmit={(values) => {
            const result = applyAgentsPickerSubmit(values);
            setAgentsSelected(result.selected);
            setAgentsPhase(result.nextPhase);
          }}
        />
      </Box>
    );
  }

  // ---------------- Agents — confirm ----------------
  // Show the diff before install starts. If the user's selection wasn't what
  // they expected (silent MultiSelect quirk, missed Space toggle), they get
  // one more chance to fix it.
  if (currentStep === "agents" && agentsPhase === "confirm") {
    const { toAdd, toRemove } = computeAgentDiff(
      agentsSelected,
      initialRegistered,
    );
    const noChanges = toAdd.length === 0 && toRemove.length === 0;
    const nothingSelected = agentsSelected.length === 0;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold>Step 2 / 4 — Agents (confirm)</Text>
        <Text color={theme.fg.muted}>
          Selected:{" "}
          {agentsSelected.length > 0 ? agentsSelected.join(", ") : "(none)"}
        </Text>
        {toAdd.length > 0 && (
          <Text color={theme.accent.primary}>
            ▸ Will install: {toAdd.join(", ")}
          </Text>
        )}
        {toRemove.length > 0 && (
          <Text color={theme.accent.warning}>
            ▸ Will remove: {toRemove.join(", ")}
          </Text>
        )}
        {nothingSelected ? (
          <Text color={theme.accent.warning}>
            ⚠ No agents selected — skip this step? (y/n)
          </Text>
        ) : noChanges ? (
          <Text color={theme.fg.muted}>
            (no changes — every selection is already registered)
          </Text>
        ) : (
          <Text>Proceed with install? (y/n)</Text>
        )}
        <Text color={theme.fg.muted}>
          (n / Esc returns to the selection screen)
        </Text>
        <ConfirmInput
          onConfirm={() => {
            setAgentsPhase("running");
            advance("agents");
          }}
          onCancel={() => {
            setAgentsPhase("picker");
          }}
        />
      </Box>
    );
  }

  // ---------------- Install ----------------
  if (currentStep === "install") {
    if (!installRunning) {
      setInstallRunning(true);
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
      void runInstallStep(toAdd, toRemove, services, (line) =>
        setInstallLog((prev) => [...prev, line]),
      ).then(() => {
        advance("install");
      });
    }
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold>Step 3 / 4 — Install + configure</Text>
        {installLog.map((line, i) => {
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
      </Box>
    );
  }

  // ---------------- Policy ----------------
  if (currentStep === "policy") {
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold>Step 4 / 4 — Policy</Text>
        <Text color={theme.fg.muted}>
          Foreman ships safe defaults (asks before any agent reads .env-shaped
          files or runs destructive shell). Want to review {services.policyPath}{" "}
          now? (y/n)
        </Text>
        <ConfirmInput
          onConfirm={async () => {
            setPolicyReview(true);
            await services.launchEditor(services.policyPath);
            advance("policy");
          }}
          onCancel={() => advance("policy")}
        />
      </Box>
    );
  }

  // ---------------- Done ----------------
  void policyReview;
  return (
    <Box flexDirection="column" gap={1} paddingY={1}>
      <StatusMessage variant="success">
        Setup complete — run 'foreman start' to launch the gateway.
      </StatusMessage>
      <Text color={theme.fg.muted}>
        Stored secrets:{" "}
        {services.secretStore
          .list()
          .map((s) => s.name)
          .join(", ") || "none"}
      </Text>
      <Text color={theme.fg.muted}>
        Registered agents:{" "}
        {services.registry
          .list()
          .map((a) => a.id)
          .join(", ") || "none"}
      </Text>
      <Box marginTop={1}>
        <ConfirmInput onConfirm={() => exit()} onCancel={() => exit()} />
      </Box>
    </Box>
  );
}

// Exported for tests. The wizard's core diff loop: install + register the
// newly-checked agents, uninstall + remove the previously-checked-now-unchecked
// ones. Idempotent — running it twice with the same toAdd/toRemove no-ops.
export async function runInstallStep(
  toAdd: string[],
  toRemove: string[],
  services: WizardServices,
  log: (line: string) => void,
): Promise<void> {
  const { doc } = loadActiveRegistry();

  // --- Process unchecks first: uninstall the binary, remove the row -----
  for (const id of toRemove) {
    const existing = services.registry.get(id);
    if (!existing) continue;
    const registryId =
      typeof existing.metadata?.registryId === "string"
        ? existing.metadata.registryId
        : null;
    const entry = registryId ? safeFind(doc, registryId) : null;
    log(`▸ Removing ${existing.displayName}`);
    services.registry.remove(id);
    log(`  ✓ unregistered "${id}"`);
    if (entry) {
      const cmd = preferredUninstallCommand(entry.install);
      if (cmd) {
        log(`  uninstalling (${cmd})…`);
        const result = await runUninstall({
          install: entry.install,
          onLine: (l) => log(`  ${l}`),
        });
        if (result.ok) log(`  ✓ ${entry.name} uninstalled`);
        else log(`  ⚠ uninstall failed (exit ${result.exitCode}); run manually: ${result.manualCommand}`);
      } else if (entry.install.script) {
        log(
          `  ⚠ ${entry.name} was installed via a script — remove the ${entry.install.binary ?? id} binary manually.`,
        );
      }
    }
  }

  // --- Then add: install, configure, register ---------------------------
  for (const id of toAdd) {
    let entry: AgentEntry;
    try {
      entry = findAgent(doc, id);
    } catch {
      log(`✗ ${id}: not in registry — skipped`);
      continue;
    }
    log(`▸ ${entry.name}`);

    // Each substep is best-effort — install / secret-check / config-inject
    // failures degrade to a warning, but registration always runs at the end.
    const detection = detectInstall(entry.install);
    if (!detection.found) {
      const installCmd = entry.install.npm
        ? `npm install -g ${entry.install.npm}`
        : entry.install.brew
          ? `brew install ${entry.install.brew}`
          : entry.install.script
            ? `curl -fsSL ${entry.install.script} | bash`
            : null;
      if (installCmd) {
        log(`  installing (${installCmd})…`);
        const result = await runInstall({
          install: entry.install,
          onLine: (l) => log(`  ${l}`),
        });
        if (!result.ok) {
          log(`  ⚠ install failed (exit ${result.exitCode})`);
          log(`    run manually: ${result.manualCommand}`);
        }
      }
    } else {
      log(`  ✓ already installed at ${detection.path}`);
    }

    const secretCheck = checkSecrets(entry, services.secretStore);
    if (!secretCheck.hasAllRequired) {
      const missing = secretCheck.required
        .filter((s) => !s.present)
        .map((s) => s.name);
      log(
        `  ⚠ required secrets missing: ${missing.join(", ")} — add via 'foreman secrets add <name>'`,
      );
    }

    const configPath = pickConfigPath(entry);
    if (configPath) {
      try {
        const snippet = buildMcpSnippet(id, entry);
        const plan = planInjection(configPath, snippet.json);
        if (plan.alreadyHasForeman) {
          log(`  ✓ config already wired at ${configPath}`);
        } else {
          applyInjection(configPath, plan);
          log(`  ✓ wrote MCP snippet to ${configPath}`);
        }
      } catch (err) {
        if (err instanceof UnsupportedConfigFormatError) {
          log(`  ⚠ ${configPath} unsupported format — paste manually`);
        } else {
          log(
            `  ⚠ config inject skipped: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    if (services.registry.get(id)) {
      log(`  ◦ already registered`);
      continue;
    }
    try {
      registerAgent({
        agentId: id,
        entry,
        registry: services.registry,
      });
      log(`  ✓ registered as "${id}"`);
      if (entry.identity_path) {
        try {
          const soulResult = applyForemanSoul(
            entry,
            getForemanPaths().soulPath,
          );
          if (soulResult?.changed) {
            log(`  ✓ wrote Foreman identity to ${soulResult.path}`);
          }
        } catch (err) {
          log(
            `  ⚠ identity write skipped: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      log(
        `  ✗ register failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (toAdd.length === 0 && toRemove.length === 0) {
    log("(no agent changes — selection matches current registration)");
  }
}

function safeFind(
  doc: ReturnType<typeof loadActiveRegistry>["doc"],
  id: string,
): AgentEntry | null {
  try {
    return findAgent(doc, id);
  } catch {
    return null;
  }
}
