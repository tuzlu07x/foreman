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
  const [secretsDone, setSecretsDone] = useState(false);

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
  const [agentsDone, setAgentsDone] = useState(false);

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
  if (currentStep === "secrets" && !secretsDone) {
    const presentSecrets = DEFAULT_SECRETS.filter((s) =>
      services.secretStore.exists(s),
    );
    const defaults = DEFAULT_SECRETS.filter(
      (s) => !presentSecrets.includes(s),
    );
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold>Step 1 / 4 — API keys</Text>
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
            setSecretsSelected(values);
            if (values.length === 0) {
              setSecretsDone(true);
              advance("secrets");
            } else {
              setSecretIdx(0);
            }
          }}
        />
      </Box>
    );
  }

  // ---------------- Secrets — value prompts ----------------
  if (currentStep === "secrets" && !secretsDone && secretsSelected.length > 0) {
    const name = secretsSelected[secretIdx];
    if (!name) {
      setSecretsDone(true);
      advance("secrets");
      return <Text>…</Text>;
    }
    const helpUrl = COMMON_SECRETS.find((s) => s.value === name)?.helpUrl;
    const progress = `(${secretIdx + 1}/${secretsSelected.length})`;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
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
          (paste the value below — it stays hidden as you type)
        </Text>
        <PasswordInput
          placeholder="…"
          onSubmit={(value) => {
            if (value.length > 0) {
              if (!services.secretStore.exists(name)) {
                services.secretStore.add(name, value);
              } else {
                services.secretStore.rotate(name, value);
              }
            }
            const nextIdx = secretIdx + 1;
            if (nextIdx >= secretsSelected.length) {
              setSecretsDone(true);
              advance("secrets");
            } else {
              setSecretIdx(nextIdx);
            }
          }}
        />
      </Box>
    );
  }

  // ---------------- Agents picker ----------------
  if (currentStep === "agents" && !agentsDone) {
    const { doc } = loadActiveRegistry();
    const options = doc.agents.map((a) => ({
      value: a.id,
      label: initialRegistered.includes(a.id)
        ? `${a.name}  (installed) — ${a.tagline}`
        : `${a.name} — ${a.tagline}`,
    }));
    const defaults =
      initialRegistered.length > 0 ? initialRegistered : DEFAULT_AGENTS;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold>Step 2 / 4 — Agents</Text>
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
            setAgentsSelected(values);
            setAgentsDone(true);
            advance("agents");
          }}
        />
      </Box>
    );
  }

  // ---------------- Install ----------------
  if (currentStep === "install") {
    if (!installRunning) {
      setInstallRunning(true);
      const toAdd = agentsSelected.filter(
        (id) => !initialRegistered.includes(id),
      );
      const toRemove = initialRegistered.filter(
        (id) => !agentsSelected.includes(id),
      );
      // Surface what's about to happen so the user catches a missed Space toggle
      // (e.g. wanted openclaw but never selected it) before install starts.
      setInstallLog([
        `Selected agents: ${agentsSelected.length > 0 ? agentsSelected.join(", ") : "(none)"}`,
        ...(toAdd.length > 0 ? [`▸ Will install: ${toAdd.join(", ")}`] : []),
        ...(toRemove.length > 0
          ? [`▸ Will remove: ${toRemove.join(", ")}`]
          : []),
        toAdd.length === 0 && toRemove.length === 0
          ? "▸ No changes — every selection is already registered."
          : "",
      ].filter(Boolean));
      void runInstallStep(toAdd, toRemove, services, (line) =>
        setInstallLog((prev) => [...prev, line]),
      ).then(() => {
        advance("install");
      });
    }
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold>Step 3 / 4 — Install + configure</Text>
        {installLog.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
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
