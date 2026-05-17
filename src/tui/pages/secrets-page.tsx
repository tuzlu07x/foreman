import { PasswordInput, TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useEffect, useMemo, useState } from "react";
import {
  loadActiveProviders,
  loadActiveServices,
  type ProviderEntry,
  type ServiceEntry,
} from "../../core/registry-catalog.js";
import type { StoredSecretMeta } from "../../core/secret-store.js";
import { useDashboardServices } from "../dashboard-context.js";
import { formatTime } from "../format.js";
import { singleBorder, theme } from "../theme.js";
import { EmptyState } from "../components/empty-state.js";
import { PageHeader } from "../components/typography.js";

export type AddSecretMode =
  | { phase: "name" }
  | { phase: "value"; name: string }
  | null;

export interface SecretsPageProps {
  selectedIdx: number;
  expanded: boolean;
  notice: string | null;
  revealedName: string | null;
  revealedValue: string | null;
  rotateMode: { name: string } | null;
  onSubmitRotate: (value: string) => void;
  addSecretMode: AddSecretMode;
  onAddSecretNameSubmit: (name: string) => void;
  onAddSecretValueSubmit: (value: string) => void;
}

// Determines whether a stored secret is managed by a higher-level TUI page
// (Providers, Services) or is a raw entry. Drives the "(managed by X)" tag
// shown next to each row + the help overlay's reframing of this page as
// the advanced low-level view.
export type SecretOwnership =
  | { kind: "providers"; entry: ProviderEntry }
  | { kind: "services"; entry: ServiceEntry }
  | { kind: "raw" };

export function ownershipForSecret(
  name: string,
  providers: ProviderEntry[],
  services: ServiceEntry[],
): SecretOwnership {
  for (const p of providers) {
    if (p.secret_name === name) return { kind: "providers", entry: p };
    if (p.endpoint_required && `${p.id}-endpoint` === name) {
      return { kind: "providers", entry: p };
    }
  }
  for (const s of services) {
    if (s.secret_name === name) return { kind: "services", entry: s };
  }
  return { kind: "raw" };
}

const REVEAL_AUTO_HIDE_MS = 10_000;

export function SecretsPage({
  selectedIdx,
  expanded,
  notice,
  revealedName,
  revealedValue,
  rotateMode,
  onSubmitRotate,
  addSecretMode,
  onAddSecretNameSubmit,
  onAddSecretValueSubmit,
}: SecretsPageProps): JSX.Element {
  const { secretStore } = useDashboardServices();
  const providers = useMemo(() => loadActiveProviders().doc.providers, []);
  const services = useMemo(() => loadActiveServices().doc.services, []);
  const [rows, setRows] = useState<StoredSecretMeta[]>(() =>
    secretStore ? secretStore.list() : [],
  );

  // Poll-only — SecretStore doesn't emit bus events today, so we rebuild
  // every 1s. Cheap because secret rows are tiny.
  useEffect(() => {
    if (!secretStore) return;
    const refresh = (): void => setRows(secretStore.list());
    const interval = setInterval(refresh, 1000);
    return () => clearInterval(interval);
  }, [secretStore]);

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

  const safeSelected = Math.max(0, Math.min(selectedIdx, rows.length - 1));

  return (
    <Box
      flexDirection="column"
      borderStyle={singleBorder()}
      borderDimColor
      paddingX={1}
      flexGrow={1}
    >
      <PageHeader
        title="Secrets (advanced)"
        right={`${rows.length} stored · AES-256-GCM`}
      />
      <Text color={theme.fg.muted}>
        Low-level view of every encrypted entry. Use [v] Providers or [V]
        Services for the higher-level surfaces that own most rows here.
      </Text>

      <Box flexDirection="column" marginTop={1}>
        {rows.length === 0 ? (
          <EmptyState
            title="No secrets stored yet"
            body="Foreman's encrypted vault holds API keys, bot tokens and webhook URLs (AES-256-GCM). Catalog-aware add flow lives in the Providers / Services pages; this page is the raw view."
            commands={[
              "foreman secrets add anthropic-key",
              "foreman secrets add telegram-bot-token",
            ]}
            hotkeys={["[n] add custom · [v] reveal · [r] rotate · [Esc] back"]}
          />
        ) : (
          rows.map((row, i) => (
            <SecretRow
              key={row.name}
              row={row}
              selected={i === safeSelected}
              expanded={expanded && i === safeSelected}
              revealedValue={
                revealedName === row.name ? revealedValue : null
              }
              ownership={ownershipForSecret(row.name, providers, services)}
            />
          ))
        )}
      </Box>

      {addSecretMode && (
        <Box
          flexDirection="column"
          marginTop={1}
          paddingX={1}
          borderStyle={singleBorder()}
          borderColor={theme.accent.warning}
        >
          {addSecretMode.phase === "name" ? (
            <>
              <Text bold color={theme.accent.warning}>
                + Add raw secret — name
              </Text>
              <Text color={theme.fg.muted}>
                (free-form name; Esc to cancel · empty cancels too)
              </Text>
              <TextInput
                placeholder="e.g. my-custom-token"
                onSubmit={onAddSecretNameSubmit}
              />
            </>
          ) : (
            <>
              <Text bold color={theme.accent.warning}>
                + Add raw secret — value for{" "}
                <Text color={theme.accent.primary}>{addSecretMode.name}</Text>
              </Text>
              <Text color={theme.fg.muted}>
                (paste below; stays hidden as you type · Esc cancels)
              </Text>
              <PasswordInput placeholder="…" onSubmit={onAddSecretValueSubmit} />
            </>
          )}
        </Box>
      )}

      {rotateMode && (
        <Box
          flexDirection="column"
          marginTop={1}
          paddingX={1}
          borderStyle={singleBorder()}
          borderColor={theme.accent.warning}
        >
          <Text>
            <Text bold color={theme.accent.warning}>
              ⟳ Rotate {rotateMode.name}
            </Text>{" "}
            <Text color={theme.fg.muted}>
              (paste new value; stays hidden as you type · Esc to cancel)
            </Text>
          </Text>
          <PasswordInput placeholder="…" onSubmit={onSubmitRotate} />
        </Box>
      )}

      {notice && (
        <Box marginTop={1}>
          <Text color={theme.accent.success}>{notice}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.fg.muted}>{"─".repeat(60)}</Text>
      </Box>
      <Text color={theme.fg.muted}>
        [↑↓] move · [Enter] expand · [n] new raw · [v] reveal{" "}
        {REVEAL_AUTO_HIDE_MS / 1000}s · [r] rotate · [d] remove · [Esc] back
      </Text>
    </Box>
  );
}

function SecretRow({
  row,
  selected,
  expanded,
  revealedValue,
  ownership,
}: {
  row: StoredSecretMeta;
  selected: boolean;
  expanded: boolean;
  revealedValue: string | null;
  ownership: SecretOwnership;
}): JSX.Element {
  const lastAccessed = row.lastAccessedAt
    ? formatTime(row.lastAccessedAt)
    : "never";
  const tag =
    ownership.kind === "providers"
      ? `(managed by Providers page — press [v])`
      : ownership.kind === "services"
        ? `(managed by Services page — press [V])`
        : null;
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={selected ? theme.accent.primary : theme.fg.muted}>
          {selected ? "▸ " : "  "}
        </Text>
        <Text color={theme.accent.primary}>{row.name}</Text>{" "}
        <Text color={theme.fg.muted}>· last accessed {lastAccessed}</Text>
        {tag && (
          <Text color={theme.fg.muted}>
            {" "}
            · {tag}
          </Text>
        )}
      </Text>
      {revealedValue !== null && (
        <Box marginLeft={2}>
          <Text color={theme.accent.warning}>
            value (auto-hides): {revealedValue}
          </Text>
        </Box>
      )}
      {expanded && (
        <Box
          flexDirection="column"
          marginLeft={2}
          marginBottom={1}
          paddingX={1}
          borderStyle={singleBorder()}
          borderDimColor
        >
          <Text color={theme.fg.muted}>name: {row.name}</Text>
          <Text color={theme.fg.muted}>last accessed: {lastAccessed}</Text>
          <Text color={theme.fg.muted}>encryption: AES-256-GCM at rest</Text>
        </Box>
      )}
    </Box>
  );
}

export { REVEAL_AUTO_HIDE_MS };
