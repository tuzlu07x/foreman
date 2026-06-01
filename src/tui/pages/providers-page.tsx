import { ConfirmInput, PasswordInput, TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import {
  buildProviderPromptList,
  storageNameForPrompt,
  type ProviderPrompt,
} from "../setup-wizard.js";
import {
  loadActiveProviders,
  type ProviderEntry,
} from "../../core/registry-catalog.js";
import { isOAuthProviderId } from "../../core/llm/oauth/oauth-providers.js";
import type { SecretStore } from "../../core/secret-store.js";
import { useDashboardServices } from "../dashboard-context.js";
import { singleBorder, theme } from "../theme.js";
import { PageHeader } from "../components/typography.js";

const REVEAL_AUTO_HIDE_MS = 10_000;

interface Row {
  provider: ProviderEntry;
  configured: boolean;
}

type Op =
  | { kind: "list" }
  | {
      kind: "adding";
      prompts: ProviderPrompt[];
      idx: number;
      warning: string | null;
    }
  | { kind: "rotating"; secretName: string }
  | { kind: "removing"; provider: ProviderEntry; dependents: string[] }
  | { kind: "revealed"; secretName: string; value: string };

export interface ProvidersPageProps {
  onLeave: () => void;
}

export function ProvidersPage({ onLeave }: ProvidersPageProps): JSX.Element {
  const { registry, secretStore, bus, runInteractiveLogin } =
    useDashboardServices();
  const catalog = useMemo(() => loadActiveProviders().doc.providers, []);
  const [rows, setRows] = useState<Row[]>(() =>
    secretStore ? buildRows(catalog, secretStore) : [],
  );
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [op, setOp] = useState<Op>({ kind: "list" });
  // Whether the selected row is expanded to show extra detail. Matches the
  // pattern used by every other list page (#280) so Enter is consistent.
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!secretStore) return;
    const refresh = (): void => setRows(buildRows(catalog, secretStore));
    const interval = setInterval(refresh, 1000);
    const off = bus.on("agent:config-updated", refresh);
    return () => {
      clearInterval(interval);
      off();
    };
  }, [catalog, secretStore, bus]);

  useEffect(() => {
    if (op.kind !== "revealed") return;
    const t = setTimeout(() => {
      setOp({ kind: "list" });
      setNotice("value auto-hidden");
    }, REVEAL_AUTO_HIDE_MS);
    return () => clearTimeout(t);
  }, [op]);

  const safeSelected = Math.max(0, Math.min(selectedIdx, rows.length - 1));
  const selectedRow = rows[safeSelected];

  useInput((input, key) => {
    if (!secretStore) return;
    if (op.kind === "adding") {
      if (key.escape) setOp({ kind: "list" });
      return;
    }
    if (op.kind === "rotating") {
      if (key.escape) setOp({ kind: "list" });
      return;
    }
    if (op.kind === "removing") {
      // ConfirmInput handles y/n; Esc cancels
      if (key.escape) setOp({ kind: "list" });
      return;
    }
    if (op.kind === "revealed") {
      if (key.escape) setOp({ kind: "list" });
      return;
    }

    // op === list
    if (key.escape) {
      onLeave();
      return;
    }
    if (key.upArrow) {
      setSelectedIdx(Math.max(0, safeSelected - 1));
      setExpanded(false);
      return;
    }
    if (key.downArrow) {
      setSelectedIdx(Math.min(rows.length - 1, safeSelected + 1));
      setExpanded(false);
      return;
    }
    if (key.return) {
      setExpanded((prev) => !prev);
      return;
    }
    if (!selectedRow) return;
    if (input === "n" && !selectedRow.configured) {
      const prompts = buildProviderPromptList(catalog, [
        selectedRow.provider.id,
      ]);
      if (prompts.length === 0) {
        setNotice(
          `${selectedRow.provider.name} has no required field — nothing to add`,
        );
        return;
      }
      setOp({ kind: "adding", prompts, idx: 0, warning: null });
      return;
    }
    if (input === "r" && selectedRow.configured) {
      const provider = selectedRow.provider;
      const secretName = provider.secret_name ?? `${provider.id}-endpoint`;
      setOp({ kind: "rotating", secretName });
      return;
    }
    if (input === "d" && selectedRow.configured) {
      const provider = selectedRow.provider;
      const dependents = registry
        .list()
        .filter((a) => a.llmProvider === provider.id)
        .map((a) => a.id);
      setOp({ kind: "removing", provider, dependents });
      return;
    }
    if (input === "s" && selectedRow.configured) {
      const provider = selectedRow.provider;
      const secretName = provider.secret_name ?? `${provider.id}-endpoint`;
      try {
        const value = secretStore.get(secretName);
        setOp({ kind: "revealed", secretName, value });
      } catch (err) {
        setNotice(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (input === "o" && isOAuthProviderId(selectedRow.provider.id)) {
      if (!runInteractiveLogin) {
        setNotice("interactive login is only available inside the TUI");
        return;
      }
      const providerId = selectedRow.provider.id;
      const results = runInteractiveLogin([
        {
          agentId: "foreman-llm",
          command: `foreman llm login ${providerId}`,
          verify: null,
          mandatory: false,
          reason: `Sign in to ${selectedRow.provider.name} so Foreman uses your subscription`,
        },
      ]);
      const ok = results.every((r) => r.succeeded);
      setRows(buildRows(catalog, secretStore));
      setNotice(
        ok
          ? `✓ signed in to ${selectedRow.provider.name} (auth_mode → oauth)`
          : `login did not complete — run 'foreman doctor' or retry [o]`,
      );
      return;
    }
  });

  if (!secretStore) {
    return (
      <Box
        flexDirection="column"
        borderStyle={singleBorder()}
        borderDimColor
        paddingX={1}
        flexGrow={1}
      >
        <Text color={theme.accent.danger}>SecretStore not wired into App</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle={singleBorder()}
      borderDimColor
      paddingX={1}
      flexGrow={1}
    >
      <PageHeader
        title="LLM Providers"
        right={
          `${rows.filter((r) => r.configured).length} configured · ` +
          `${rows.filter((r) => !r.configured).length} available`
        }
      />

      <Box flexDirection="column" marginTop={1}>
        {rows.length === 0 ? (
          <Text color={theme.fg.muted}>
            (no providers in catalog — re-install foreman-agent?)
          </Text>
        ) : (
          rows.map((row, i) => (
            <ProviderRow
              key={row.provider.id}
              row={row}
              selected={i === safeSelected}
              expanded={expanded && i === safeSelected}
              registry={registry}
            />
          ))
        )}
      </Box>

      {op.kind === "adding" && (
        <AddingOverlay
          op={op}
          catalog={catalog}
          setOp={setOp}
          setNotice={setNotice}
          secretStore={secretStore}
        />
      )}
      {op.kind === "rotating" && (
        <RotatingOverlay
          secretName={op.secretName}
          onDone={(message) => {
            setOp({ kind: "list" });
            setNotice(message);
          }}
          secretStore={secretStore}
        />
      )}
      {op.kind === "removing" && (
        <RemovingOverlay
          provider={op.provider}
          dependents={op.dependents}
          onDone={(message) => {
            setOp({ kind: "list" });
            setNotice(message);
          }}
          secretStore={secretStore}
        />
      )}
      {op.kind === "revealed" && (
        <Box
          flexDirection="column"
          marginTop={1}
          paddingX={1}
          borderStyle={singleBorder()}
          borderColor={theme.accent.warning}
        >
          <Text color={theme.accent.warning}>
            value (auto-hides in {REVEAL_AUTO_HIDE_MS / 1000}s):
          </Text>
          <Text>{op.value}</Text>
          <Text color={theme.fg.muted}>[Esc] hide now</Text>
        </Box>
      )}

      {notice && op.kind === "list" && (
        <Box marginTop={1}>
          <Text color={theme.accent.success}>{notice}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.fg.muted}>{"─".repeat(60)}</Text>
      </Box>
      <Text color={theme.fg.muted}>
        [↑↓] move · [n] new (on available) · [o] OAuth login (Claude/Codex) ·
        [r] rotate · [d] remove · [s] show 10s · [Esc] back
      </Text>
    </Box>
  );
}

function buildRows(catalog: ProviderEntry[], secretStore: SecretStore): Row[] {
  return catalog.map((p) => {
    const configured = p.secret_name
      ? secretStore.exists(p.secret_name)
      : secretStore.exists(`${p.id}-endpoint`);
    return { provider: p, configured };
  });
}

function ProviderRow({
  row,
  selected,
  expanded,
  registry,
}: {
  row: Row;
  selected: boolean;
  expanded: boolean;
  registry: ReturnType<typeof useDashboardServices>["registry"];
}): JSX.Element {
  const cursor = selected ? "▸ " : "  ";
  const dot = row.configured ? theme.symbols.activeDot : theme.symbols.idleDot;
  const dotColor = row.configured ? theme.accent.success : theme.fg.muted;
  const consumers = row.configured
    ? registry
        .list()
        .filter((a) => a.llmProvider === row.provider.id)
        .map((a) => a.id)
    : [];
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={selected ? theme.accent.primary : theme.fg.muted}>
          {cursor}
        </Text>
        <Text color={dotColor}>{dot}</Text>{" "}
        <Text color={theme.accent.primary}>{row.provider.name}</Text>{" "}
        <Text color={theme.fg.muted}>
          {row.configured
            ? `(${row.provider.secret_name ?? `${row.provider.id}-endpoint`}) · used by ${consumers.length} agent${consumers.length === 1 ? "" : "s"}${consumers.length > 0 ? ` (${consumers.join(", ")})` : ""}`
            : `(available — press [n] to configure)`}
        </Text>
      </Text>
      {expanded ? (
        <Box
          flexDirection="column"
          marginLeft={4}
          marginTop={1}
          marginBottom={1}
        >
          <Text color={theme.fg.muted}>
            id: <Text color={theme.fg.default}>{row.provider.id}</Text>
          </Text>
          <Text color={theme.fg.muted}>
            secret_name:{" "}
            <Text color={theme.fg.default}>
              {row.provider.secret_name ?? "—"}
            </Text>
          </Text>
          {row.provider.endpoint_required ? (
            <Text color={theme.fg.muted}>
              endpoint: <Text color={theme.fg.default}>required</Text>
            </Text>
          ) : null}
          <Text color={theme.fg.muted}>
            homepage:{" "}
            <Text color={theme.accent.primary}>
              {row.provider.where_to_get}
            </Text>
          </Text>
          {row.configured ? (
            <Text color={theme.fg.muted}>
              consumers:{" "}
              <Text color={theme.fg.default}>
                {consumers.length === 0 ? "(none)" : consumers.join(", ")}
              </Text>
            </Text>
          ) : null}
          <Text color={theme.fg.muted}>
            actions:{" "}
            {row.configured
              ? "[s] show · [r] rotate · [d] remove"
              : "[n] configure"}
            {isOAuthProviderId(row.provider.id) ? " · [o] OAuth login" : ""}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function AddingOverlay({
  op,
  catalog,
  setOp,
  setNotice,
  secretStore,
}: {
  op: Extract<Op, { kind: "adding" }>;
  catalog: ProviderEntry[];
  setOp: (op: Op) => void;
  setNotice: (n: string | null) => void;
  secretStore: SecretStore;
}): JSX.Element {
  const prompt = op.prompts[op.idx];
  if (!prompt) {
    setOp({ kind: "list" });
    return <Text>…</Text>;
  }
  const provider = catalog.find((p) => p.id === prompt.providerId);
  if (!provider) {
    setOp({ kind: "list" });
    return <Text>…</Text>;
  }
  const isEndpoint = prompt.kind === "endpoint";
  const fieldLabel = isEndpoint
    ? `${provider.name} endpoint`
    : `${provider.name} API key`;
  const progress = `(${op.idx + 1}/${op.prompts.length})`;
  const onSubmit = (value: string): void => {
    if (value.length === 0) {
      setOp({
        kind: "adding",
        prompts: op.prompts,
        idx: op.idx,
        warning: "value cannot be empty (Esc to cancel)",
      });
      return;
    }
    try {
      const storageName = storageNameForPrompt(prompt, provider);
      if (secretStore.exists(storageName)) {
        secretStore.rotate(storageName, value);
      } else {
        secretStore.add(storageName, value);
      }
    } catch (err) {
      setOp({
        kind: "adding",
        prompts: op.prompts,
        idx: op.idx,
        warning: `failed to store: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    const nextIdx = op.idx + 1;
    if (nextIdx >= op.prompts.length) {
      setOp({ kind: "list" });
      setNotice(`✓ ${provider.name} configured`);
    } else {
      setOp({
        kind: "adding",
        prompts: op.prompts,
        idx: nextIdx,
        warning: null,
      });
    }
  };
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      paddingX={1}
      borderStyle={singleBorder()}
      borderColor={theme.accent.warning}
    >
      <Text color={theme.accent.warning}>
        Adding {fieldLabel} {progress}
      </Text>
      {provider.where_to_get && (
        <Text color={theme.fg.muted}>
          Get yours at:{" "}
          <Text color={theme.accent.primary}>{provider.where_to_get}</Text>
        </Text>
      )}
      {provider.format_hint && (
        <Text color={theme.fg.muted}>
          Expected format: {provider.format_hint}
        </Text>
      )}
      {op.warning && <Text color={theme.accent.danger}>⚠ {op.warning}</Text>}
      {isEndpoint ? (
        <TextInput
          defaultValue={provider.endpoint_default ?? ""}
          placeholder={provider.endpoint_default ?? "endpoint URL"}
          onSubmit={onSubmit}
        />
      ) : (
        <PasswordInput placeholder="…" onSubmit={onSubmit} />
      )}
      <Text color={theme.fg.muted}>[Enter] save · [Esc] cancel</Text>
    </Box>
  );
}

function RotatingOverlay({
  secretName,
  onDone,
  secretStore,
}: {
  secretName: string;
  onDone: (message: string) => void;
  secretStore: SecretStore;
}): JSX.Element {
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      paddingX={1}
      borderStyle={singleBorder()}
      borderColor={theme.accent.warning}
    >
      <Text color={theme.accent.warning}>
        ⟳ Rotate {secretName} — paste new value (Enter saves · Esc cancels)
      </Text>
      <PasswordInput
        placeholder="…"
        onSubmit={(value) => {
          if (value.length === 0) {
            onDone("rotate cancelled (empty input)");
            return;
          }
          try {
            secretStore.rotate(secretName, value);
            onDone(`✓ ${secretName} rotated`);
          } catch (err) {
            onDone(
              `error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }}
      />
    </Box>
  );
}

function RemovingOverlay({
  provider,
  dependents,
  onDone,
  secretStore,
}: {
  provider: ProviderEntry;
  dependents: string[];
  onDone: (message: string) => void;
  secretStore: SecretStore;
}): JSX.Element {
  const secretName = provider.secret_name ?? `${provider.id}-endpoint`;
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      paddingX={1}
      borderStyle={singleBorder()}
      borderColor={theme.accent.danger}
    >
      <Text color={theme.accent.danger}>Remove {provider.name}?</Text>
      <Text color={theme.fg.muted}>
        This will delete {secretName} from the secret store.
      </Text>
      {dependents.length > 0 && (
        <Text color={theme.accent.warning}>
          ⚠ {dependents.length} agent{dependents.length === 1 ? "" : "s"}{" "}
          currently use this provider: {dependents.join(", ")} (they'll fail
          until you re-add it or switch their LLM).
        </Text>
      )}
      <Text>Confirm? (y/n)</Text>
      <ConfirmInput
        onConfirm={() => {
          try {
            secretStore.remove(secretName);
            onDone(`✓ ${provider.name} removed`);
          } catch (err) {
            onDone(
              `error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }}
        onCancel={() => onDone("remove cancelled")}
      />
    </Box>
  );
}
