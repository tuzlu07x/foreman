import { existsSync } from "node:fs";
import { Box, Text } from "ink";
import {
  featureSplit,
  getBudgetStatus,
  type BudgetStatus,
  type FeatureSplit,
} from "../../core/llm/budget.js";
import { loadLlmConfig, type LlmConfig } from "../../core/llm/config.js";
import { getDb } from "../../db/client.js";
import { getForemanPaths } from "../../utils/config.js";
import { useDashboardServices } from "../dashboard-context.js";
import { singleBorder, theme } from "../theme.js";

export interface SettingsPageProps {
  selectedIdx: number;
  notice: string | null;
}

interface SettingsItem {
  key: string;
  title: string;
  detail: string;
  action: "edit-soul" | "edit-policy" | "open-policy" | "wizard-instruction";
}

export function buildSettingsItems(
  soulPath: string | null,
  policyPath: string | null,
): SettingsItem[] {
  const items: SettingsItem[] = [];
  if (soulPath) {
    items.push({
      key: "e",
      title: "Edit Foreman SOUL.md (agent identity)",
      detail: soulPath,
      action: "edit-soul",
    });
  }
  if (policyPath) {
    items.push({
      key: "p",
      title: "Edit policy.yaml",
      detail: policyPath,
      action: "edit-policy",
    });
    items.push({
      key: "P",
      title: "Open Policy page",
      detail: "view + toggle rules without leaving the TUI",
      action: "open-policy",
    });
  }
  items.push({
    key: "w",
    title: "Re-run setup wizard",
    detail: "quit and run: foreman setup --resume  (or --reset)",
    action: "wizard-instruction",
  });
  return items;
}

export function SettingsPage({
  selectedIdx,
  notice,
}: SettingsPageProps): JSX.Element {
  const { policyPath } = useDashboardServices();
  const soulPath = useDashboardServices().soulPath ?? null;
  const items = buildSettingsItems(soulPath, policyPath ?? null);
  const safeSelected = Math.max(0, Math.min(selectedIdx, items.length - 1));
  const llmSnapshot = readLlmSnapshot();

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
          Settings
        </Text>
        <Text color={theme.fg.muted}>{items.length} items</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {items.map((item, i) => (
          <Box flexDirection="column" key={`${item.action}-${i}`}>
            <Text>
              <Text
                color={i === safeSelected ? theme.accent.primary : theme.fg.muted}
              >
                {i === safeSelected ? "▸ " : "  "}
              </Text>
              <Text color={theme.accent.primary}>[{item.key}]</Text>{" "}
              <Text bold>{item.title}</Text>
            </Text>
            <Box marginLeft={6}>
              <Text color={theme.fg.muted}>{item.detail}</Text>
            </Box>
          </Box>
        ))}
      </Box>

      {llmSnapshot ? <LlmTile snapshot={llmSnapshot} /> : null}

      {notice && (
        <Box marginTop={1}>
          <Text color={theme.accent.success}>{notice}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.fg.muted}>{"─".repeat(60)}</Text>
      </Box>
      <Text color={theme.fg.muted}>
        [↑↓] move · [Enter] run selected · letters above also trigger directly ·
        [Esc] back
      </Text>
    </Box>
  );
}

interface LlmSnapshot {
  enabled: boolean;
  provider: string;
  model: string;
  features: { verification: boolean; smart_report: boolean; policy_suggestions: boolean };
  status: BudgetStatus;
  split: FeatureSplit[];
  daysUntilReset: number;
}

function readLlmSnapshot(): LlmSnapshot | null {
  const paths = getForemanPaths();
  if (!existsSync(paths.llmConfigPath)) return null;
  try {
    const config = loadLlmConfig(paths.llmConfigPath);
    const db = getDb();
    const status = getBudgetStatus(db, config);
    const split = featureSplit(db, config);
    const daysUntilReset = Math.max(
      0,
      Math.ceil((status.windowEnd - Date.now()) / 86_400_000),
    );
    return {
      enabled: config.enabled,
      provider: config.provider,
      model: config.model,
      features: config.features,
      status,
      split,
      daysUntilReset,
    };
  } catch {
    return null;
  }
}

function LlmTile({ snapshot }: { snapshot: LlmSnapshot }): JSX.Element {
  const exhausted = snapshot.status.spentUsd >= snapshot.status.capUsd;
  const tripped = snapshot.status.alertTripped && !exhausted;
  const barColor = exhausted
    ? theme.accent.danger
    : tripped
      ? theme.accent.warning
      : theme.accent.success;
  const headerLabel = snapshot.enabled
    ? `✓ enabled · ${snapshot.provider} ${snapshot.model}`
    : `○ disabled · ${snapshot.provider} ${snapshot.model}`;
  const headerColor = snapshot.enabled ? theme.accent.success : theme.fg.muted;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>LLM Smart Features</Text>
      <Box marginLeft={2}>
        <Text color={headerColor}>{headerLabel}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text>
          Budget: <Text bold>${snapshot.status.spentUsd.toFixed(2)}</Text> /
          ${snapshot.status.capUsd.toFixed(2)} (
          {snapshot.status.spentPct.toFixed(0)}%)
          {tripped ? <Text color={theme.accent.warning}> ⚠ alert</Text> : null}
          {exhausted ? <Text color={theme.accent.danger}> ✗ exhausted</Text> : null}
        </Text>
      </Box>
      <Box marginLeft={2}>
        <Text color={barColor}>{renderBar(snapshot.status.spentPct, 28)}</Text>
        <Text color={theme.fg.muted}>
          {" "}
          resets in {snapshot.daysUntilReset} day
          {snapshot.daysUntilReset === 1 ? "" : "s"}
        </Text>
      </Box>
      <Box marginLeft={2}>
        <Text color={theme.fg.muted}>
          Features:{" "}
          <Text color={snapshot.features.verification ? theme.accent.success : theme.fg.muted}>
            verification {snapshot.features.verification ? "✓" : "✗"}
          </Text>
          {" · "}
          <Text color={snapshot.features.smart_report ? theme.accent.success : theme.fg.muted}>
            smart_report {snapshot.features.smart_report ? "✓" : "✗"}
          </Text>
          {" · "}
          <Text color={snapshot.features.policy_suggestions ? theme.accent.success : theme.fg.muted}>
            policy_suggestions {snapshot.features.policy_suggestions ? "✓" : "✗"}
          </Text>
        </Text>
      </Box>
      {snapshot.split.length > 0 ? (
        <Box marginLeft={2}>
          <Text color={theme.fg.muted}>
            Split:{" "}
            {snapshot.split
              .map((s) => `${s.feature} $${s.spentUsd.toFixed(2)}`)
              .join(" · ")}
          </Text>
        </Box>
      ) : null}
      <Box marginLeft={2} marginTop={1}>
        <Text color={theme.fg.muted}>
          Tweak via CLI: <Text bold>foreman llm budget --set N</Text> ·{" "}
          <Text bold>foreman llm usage --since=7d</Text>
        </Text>
      </Box>
    </Box>
  );
}

function renderBar(pct: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}
