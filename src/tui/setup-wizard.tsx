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
import { detectInstall, runInstall } from "../core/agent-install.js";
import { buildMcpSnippet } from "../core/agent-mcp-snippet.js";
import {
  findAgent,
  loadActiveRegistry,
  type AgentEntry,
} from "../core/registry-catalog.js";
import { RegistryService } from "../core/registry.js";
import { SecretStore } from "../core/secret-store.js";
import type { ForemanDb } from "../db/client.js";
import {
  markCompleted,
  saveSetupState,
  type SetupState,
  type Step,
} from "./setup-state.js";
import { theme } from "./theme.js";

const COMMON_SECRETS = [
  { value: "anthropic-key", label: "Anthropic API key" },
  { value: "openai-key", label: "OpenAI API key" },
  { value: "gemini-api-key", label: "Google Gemini API key" },
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

  const [agentsSelected, setAgentsSelected] = useState<string[]>(DEFAULT_AGENTS);
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
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold>Step 1 / 4 — API keys</Text>
        <Text color={theme.fg.muted}>
          Pick the keys you'll use. Foreman encrypts them on disk and hands
          them to agents on demand. (Space to toggle, Enter to confirm.)
        </Text>
        <MultiSelect
          options={COMMON_SECRETS}
          defaultValue={[]}
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
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text>
          {theme.symbols.bullet} Value for{" "}
          <Text bold color={theme.accent.primary}>
            {name}
          </Text>
          :
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
      label: `${a.name} — ${a.tagline}`,
    }));
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        <Text bold>Step 2 / 4 — Agents</Text>
        <Text color={theme.fg.muted}>
          Pick the agents you want Foreman to mediate. (Space to toggle, Enter
          to confirm.)
        </Text>
        <MultiSelect
          options={options}
          defaultValue={DEFAULT_AGENTS}
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
      void runInstallStep(
        agentsSelected,
        services,
        (line) => setInstallLog((prev) => [...prev, line]),
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
        Stored secrets: {services.secretStore.list().map((s) => s.name).join(", ") || "none"}
      </Text>
      <Text color={theme.fg.muted}>
        Registered agents:{" "}
        {services.registry.list().map((a) => a.id).join(", ") || "none"}
      </Text>
      <Box marginTop={1}>
        <ConfirmInput onConfirm={() => exit()} onCancel={() => exit()} />
      </Box>
    </Box>
  );
}

async function runInstallStep(
  selectedIds: string[],
  services: WizardServices,
  log: (line: string) => void,
): Promise<void> {
  const { doc } = loadActiveRegistry();
  for (const id of selectedIds) {
    let entry: AgentEntry;
    try {
      entry = findAgent(doc, id);
    } catch {
      log(`✗ ${id}: not in registry — skipped`);
      continue;
    }
    log(`▸ ${entry.name}`);
    const detection = detectInstall(entry.install);
    if (!detection.found && (entry.install.npm || entry.install.brew)) {
      log(`  installing ${entry.install.npm ?? entry.install.brew}…`);
      const result = await runInstall({
        install: entry.install,
        onLine: (l) => log(`  ${l}`),
      });
      if (!result.ok) {
        log(`  ✗ install failed (exit ${result.exitCode})`);
        log(`    manual: ${result.manualCommand}`);
        continue;
      }
    } else if (detection.found) {
      log(`  ✓ already installed at ${detection.path}`);
    }

    const secretCheck = checkSecrets(entry, services.secretStore);
    if (!secretCheck.hasAllRequired) {
      const missing = secretCheck.required
        .filter((s) => !s.present)
        .map((s) => s.name);
      log(`  ✗ required secrets missing: ${missing.join(", ")} — re-run with -- setup`);
      continue;
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
            `  ✗ config inject failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    if (services.registry.get(id)) {
      log(`  ◦ already registered — skipping`);
      continue;
    }
    try {
      registerAgent({
        agentId: id,
        entry,
        registry: services.registry,
      });
      log(`  ✓ registered as "${id}"`);
    } catch (err) {
      log(
        `  ✗ register failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
