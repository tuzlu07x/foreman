import { ConfirmInput, PasswordInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import {
  loadActiveServices,
  type ServiceEntry,
} from "../../core/registry-catalog.js";
import type { SecretStore } from "../../core/secret-store.js";
import { useDashboardServices } from "../dashboard-context.js";
import { osc8 } from "../osc8.js";
import { singleBorder, theme } from "../theme.js";

const REVEAL_AUTO_HIDE_MS = 10_000;

interface Row {
  service: ServiceEntry;
  configured: boolean;
}

// Page-local op state (same pattern as providers-page) — keeps the App-level
// keyboard handler from ballooning as we add more management pages.
type Op =
  | { kind: "list" }
  | { kind: "adding"; service: ServiceEntry; warning: string | null }
  | { kind: "rotating"; service: ServiceEntry }
  | { kind: "removing"; service: ServiceEntry; dependents: string[] }
  | { kind: "revealed"; secretName: string; value: string }
  | { kind: "walkthrough"; service: ServiceEntry };

export interface ServicesPageProps {
  onLeave: () => void;
}

export function ServicesPage({ onLeave }: ServicesPageProps): JSX.Element {
  const { registry, secretStore, bus } = useDashboardServices();
  const catalog = useMemo(() => loadActiveServices().doc.services, []);
  const [rows, setRows] = useState<Row[]>(() =>
    secretStore ? buildRows(catalog, secretStore) : [],
  );
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [op, setOp] = useState<Op>({ kind: "list" });

  useEffect(() => {
    if (!secretStore) return;
    const refresh = (): void => setRows(buildRows(catalog, secretStore));
    const interval = setInterval(refresh, 1000);
    const off = bus.on("agent:registered", refresh);
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
    if (
      op.kind === "adding" ||
      op.kind === "rotating" ||
      op.kind === "removing" ||
      op.kind === "revealed"
    ) {
      if (key.escape) setOp({ kind: "list" });
      return;
    }
    if (op.kind === "walkthrough") {
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
      return;
    }
    if (key.downArrow) {
      setSelectedIdx(Math.min(rows.length - 1, safeSelected + 1));
      return;
    }
    if (!selectedRow) return;
    if (input === "n" && !selectedRow.configured) {
      setOp({ kind: "adding", service: selectedRow.service, warning: null });
      return;
    }
    if (input === "r" && selectedRow.configured) {
      setOp({ kind: "rotating", service: selectedRow.service });
      return;
    }
    if (input === "d" && selectedRow.configured) {
      const service = selectedRow.service;
      const installed = registry.list().map((a) => a.id);
      const dependents = service.used_by_agents.filter((id) =>
        installed.includes(id),
      );
      setOp({ kind: "removing", service, dependents });
      return;
    }
    if (input === "s" && selectedRow.configured) {
      const service = selectedRow.service;
      try {
        const value = secretStore.get(service.secret_name);
        setOp({ kind: "revealed", secretName: service.secret_name, value });
      } catch (err) {
        setNotice(
          `error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    if (input === "w") {
      setOp({ kind: "walkthrough", service: selectedRow.service });
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
        <Text color={theme.accent.danger}>
          SecretStore not wired into App
        </Text>
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
      <Box justifyContent="space-between">
        <Text color={theme.accent.primary} bold>
          Services
        </Text>
        <Text color={theme.fg.muted}>
          {rows.filter((r) => r.configured).length} configured ·{" "}
          {rows.filter((r) => !r.configured).length} available
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {rows.length === 0 ? (
          <Text color={theme.fg.muted}>
            (no services in catalog — re-install foreman-agent?)
          </Text>
        ) : (
          rows.map((row, i) => (
            <ServiceRow
              key={row.service.id}
              row={row}
              selected={i === safeSelected}
              registry={registry}
            />
          ))
        )}
      </Box>

      {op.kind === "adding" && (
        <AddingOverlay
          service={op.service}
          warning={op.warning}
          secretStore={secretStore}
          onDone={(message) => {
            setOp({ kind: "list" });
            setNotice(message);
          }}
        />
      )}
      {op.kind === "rotating" && (
        <RotatingOverlay
          service={op.service}
          secretStore={secretStore}
          onDone={(message) => {
            setOp({ kind: "list" });
            setNotice(message);
          }}
        />
      )}
      {op.kind === "removing" && (
        <RemovingOverlay
          service={op.service}
          dependents={op.dependents}
          secretStore={secretStore}
          onDone={(message) => {
            setOp({ kind: "list" });
            setNotice(message);
          }}
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
      {op.kind === "walkthrough" && (
        <WalkthroughOverlay service={op.service} />
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
        [↑↓] move · [n] new · [r] rotate · [d] remove · [s] show 10s · [w]
        walkthrough · [Esc] back
      </Text>
    </Box>
  );
}

function buildRows(
  catalog: ServiceEntry[],
  secretStore: SecretStore,
): Row[] {
  return catalog.map((s) => ({
    service: s,
    configured: secretStore.exists(s.secret_name),
  }));
}

function ServiceRow({
  row,
  selected,
  registry,
}: {
  row: Row;
  selected: boolean;
  registry: ReturnType<typeof useDashboardServices>["registry"];
}): JSX.Element {
  const cursor = selected ? "▸ " : "  ";
  const dot = row.configured ? theme.symbols.activeDot : theme.symbols.idleDot;
  const dotColor = row.configured ? theme.accent.success : theme.fg.muted;
  const installed = row.configured
    ? registry.list().map((a) => a.id)
    : [];
  const consumers = row.configured
    ? row.service.used_by_agents.filter((id) => installed.includes(id))
    : [];
  return (
    <Text>
      <Text color={selected ? theme.accent.primary : theme.fg.muted}>
        {cursor}
      </Text>
      <Text color={dotColor}>{dot}</Text>{" "}
      <Text color={theme.accent.primary}>{row.service.name}</Text>{" "}
      <Text color={theme.fg.muted}>
        {row.configured
          ? `(${row.service.secret_name}) · used by ${consumers.length} installed agent${consumers.length === 1 ? "" : "s"}${consumers.length > 0 ? ` (${consumers.join(", ")})` : ""}`
          : `(available — press [n] to configure)`}
      </Text>
    </Text>
  );
}

function AddingOverlay({
  service,
  warning,
  secretStore,
  onDone,
}: {
  service: ServiceEntry;
  warning: string | null;
  secretStore: SecretStore;
  onDone: (message: string) => void;
}): JSX.Element {
  const onSubmit = (value: string): void => {
    if (value.length === 0) {
      onDone(`add ${service.name} cancelled (empty value)`);
      return;
    }
    try {
      if (secretStore.exists(service.secret_name)) {
        secretStore.rotate(service.secret_name, value);
      } else {
        secretStore.add(service.secret_name, value);
      }
      onDone(`✓ ${service.name} configured`);
    } catch (err) {
      onDone(`error: ${err instanceof Error ? err.message : String(err)}`);
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
        Adding {service.name} token
      </Text>
      {service.where_to_get && (
        <Text color={theme.fg.muted}>
          Get yours at:{" "}
          <Text color={theme.accent.primary}>
            {service.open_url_hotkey
              ? osc8(service.where_to_get)
              : service.where_to_get}
          </Text>
        </Text>
      )}
      <Text color={theme.fg.muted}>Expected format: {service.format_hint}</Text>
      {warning && <Text color={theme.accent.danger}>⚠ {warning}</Text>}
      <PasswordInput placeholder="…" onSubmit={onSubmit} />
      <Text color={theme.fg.muted}>[Enter] save · [Esc] cancel</Text>
    </Box>
  );
}

function RotatingOverlay({
  service,
  secretStore,
  onDone,
}: {
  service: ServiceEntry;
  secretStore: SecretStore;
  onDone: (message: string) => void;
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
        ⟳ Rotate {service.secret_name} — paste new value (Enter saves · Esc
        cancels)
      </Text>
      <PasswordInput
        placeholder="…"
        onSubmit={(value) => {
          if (value.length === 0) {
            onDone("rotate cancelled (empty input)");
            return;
          }
          try {
            secretStore.rotate(service.secret_name, value);
            onDone(`✓ ${service.secret_name} rotated`);
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
  service,
  dependents,
  secretStore,
  onDone,
}: {
  service: ServiceEntry;
  dependents: string[];
  secretStore: SecretStore;
  onDone: (message: string) => void;
}): JSX.Element {
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      paddingX={1}
      borderStyle={singleBorder()}
      borderColor={theme.accent.danger}
    >
      <Text color={theme.accent.danger}>Remove {service.name}?</Text>
      <Text color={theme.fg.muted}>
        This will delete {service.secret_name} from the secret store. The
        bot/integration itself stays on the service side — message
        @BotFather / revoke the token there if you want it fully gone.
      </Text>
      {dependents.length > 0 && (
        <Text color={theme.accent.warning}>
          ⚠ {dependents.length} installed agent
          {dependents.length === 1 ? "" : "s"} currently use this:{" "}
          {dependents.join(", ")} (their integration will go offline).
        </Text>
      )}
      <Text>Confirm? (y/n)</Text>
      <ConfirmInput
        onConfirm={() => {
          try {
            secretStore.remove(service.secret_name);
            onDone(`✓ ${service.name} removed`);
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

function WalkthroughOverlay({
  service,
}: {
  service: ServiceEntry;
}): JSX.Element {
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      paddingX={1}
      borderStyle={singleBorder()}
      borderColor={theme.accent.primary}
    >
      <Text bold color={theme.accent.primary}>
        {service.name} setup walkthrough
      </Text>
      {service.setup_steps.map((step, i) => (
        <Text key={i} color={theme.fg.muted}>
          {"  "}
          {i + 1}. {step}
        </Text>
      ))}
      {service.where_to_get && (
        <Text color={theme.fg.muted}>
          {"\n"}
          Get yours at:{" "}
          <Text color={theme.accent.primary}>
            {service.open_url_hotkey
              ? osc8(service.where_to_get)
              : service.where_to_get}
          </Text>
        </Text>
      )}
      <Text color={theme.fg.muted}>Expected format: {service.format_hint}</Text>
      <Text color={theme.fg.muted}>[Esc] close</Text>
    </Box>
  );
}
