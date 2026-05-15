import { PasswordInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { StoredSecretMeta } from "../../core/secret-store.js";
import { useDashboardServices } from "../dashboard-context.js";
import { formatTime } from "../format.js";
import { singleBorder, theme } from "../theme.js";

export interface SecretsPageProps {
  selectedIdx: number;
  expanded: boolean;
  notice: string | null;
  revealedName: string | null;
  revealedValue: string | null;
  rotateMode: { name: string } | null;
  onSubmitRotate: (value: string) => void;
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
}: SecretsPageProps): JSX.Element {
  const { secretStore } = useDashboardServices();
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
      <Box justifyContent="space-between">
        <Text color={theme.accent.primary} bold>
          Secrets
        </Text>
        <Text color={theme.fg.muted}>{rows.length} stored · AES-256-GCM</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {rows.length === 0 ? (
          <Text color={theme.fg.muted}>
            (no secrets stored — run 'foreman setup' or 'foreman secrets add &lt;name&gt;')
          </Text>
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
            />
          ))
        )}
      </Box>

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
        [↑↓] move · [Enter] expand · [v] reveal {REVEAL_AUTO_HIDE_MS / 1000}s ·
        [r] rotate · [d] remove · [Esc] back
      </Text>
    </Box>
  );
}

function SecretRow({
  row,
  selected,
  expanded,
  revealedValue,
}: {
  row: StoredSecretMeta;
  selected: boolean;
  expanded: boolean;
  revealedValue: string | null;
}): JSX.Element {
  const lastAccessed = row.lastAccessedAt
    ? formatTime(row.lastAccessedAt)
    : "never";
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={selected ? theme.accent.primary : theme.fg.muted}>
          {selected ? "▸ " : "  "}
        </Text>
        <Text color={theme.accent.primary}>{row.name}</Text>{" "}
        <Text color={theme.fg.muted}>· last accessed {lastAccessed}</Text>
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
