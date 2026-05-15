import { Box, Text } from "ink";
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
