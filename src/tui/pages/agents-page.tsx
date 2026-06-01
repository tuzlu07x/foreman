import { Select, TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useEffect, useMemo, useState } from "react";
import {
  loadActiveProviders,
  type ProviderEntry,
} from "../../core/registry-catalog.js";
import type { RegisteredAgent } from "../../core/registry.js";
import { useDashboardServices } from "../dashboard-context.js";
import { formatTime } from "../format.js";
import { singleBorder, theme } from "../theme.js";
import { EmptyState } from "../components/empty-state.js";
import { PageHeader } from "../components/typography.js";

export interface DaemonCrashInfo {
  agentId: string;
  exitCode: number;
  stderrHint: string;
  crashedAt: number;
}

export interface AgentsPageProps {
  selectedIdx: number;
  expanded: boolean;
  notice: string | null;
  editMode?: "none" | "note" | "llm";
  llmDraft?: string | null;
  onLlmDraftChange?: (value: string) => void;
  onNoteSubmit?: (value: string) => void;
  daemonCrashes?: DaemonCrashInfo[];
}

export function AgentsPage({
  selectedIdx,
  expanded,
  notice,
  editMode = "none",
  llmDraft = null,
  onLlmDraftChange,
  onNoteSubmit,
  daemonCrashes = [],
}: AgentsPageProps): JSX.Element {
  const { registry, bus } = useDashboardServices();
  const [rows, setRows] = useState<RegisteredAgent[]>(() => registry.listAll());
  const providers = useMemo(() => loadActiveProviders().doc.providers, []);

  useEffect(() => {
    const refresh = (): void => setRows(registry.listAll());
    const offRegistered = bus.on("agent:registered", refresh);
    const offRemoved = bus.on("agent:removed", refresh);
    const offHeartbeat = bus.on("agent:heartbeat", refresh);
    const offRotated = bus.on("agent:key-rotated", refresh);
    const offConfig = bus.on("agent:config-updated", refresh);
    const interval = setInterval(refresh, 2000);
    return () => {
      offRegistered();
      offRemoved();
      offHeartbeat();
      offRotated();
      offConfig();
      clearInterval(interval);
    };
  }, [registry, bus]);

  const safeSelected = Math.max(0, Math.min(selectedIdx, rows.length - 1));
  const crashMap = useMemo(() => {
    const map = new Map<string, DaemonCrashInfo>();
    for (const c of daemonCrashes) map.set(c.agentId, c);
    return map;
  }, [daemonCrashes]);

  return (
    <Box
      flexDirection="column"
      borderStyle={singleBorder()}
      borderDimColor
      paddingX={1}
      flexGrow={1}
    >
      <PageHeader
        title="Agents"
        right={
          `${rows.length} registered · ` +
          `${rows.filter((r) => r.status === "active" && !crashMap.has(r.id)).length} active · ` +
          `${crashMap.size} crashed · ` +
          `${rows.filter((r) => r.status === "disabled").length} disabled · ` +
          `${rows.filter((r) => r.status === "blocked").length} blocked`
        }
      />

      <Box flexDirection="column" marginTop={1}>
        {rows.length === 0 ? (
          <EmptyState
            title="No agents registered yet"
            body="Foreman guards every MCP-compatible agent you connect. Once you register one, it shows up here with status, last-seen, and the policy rules it's bound by."
            commands={[
              "foreman setup",
              "foreman agent add hermes --type hermes",
            ]}
            hotkeys={["[Esc] back to dashboard"]}
          />
        ) : (
          rows.map((agent, i) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              selected={i === safeSelected}
              expanded={expanded && i === safeSelected}
              providers={providers}
              editMode={i === safeSelected ? editMode : "none"}
              llmDraft={llmDraft}
              onLlmDraftChange={onLlmDraftChange}
              onNoteSubmit={onNoteSubmit}
              crash={crashMap.get(agent.id) ?? null}
            />
          ))
        )}
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
        [↑↓] move · [Enter] expand · [o] login · [N] edit note · [L] change LLM
        · [d] disable · [e] enable · [b] block/unblock · [r] remove · [R]
        regen-key · [Esc] back
      </Text>
    </Box>
  );
}

function AgentRow({
  agent,
  selected,
  expanded,
  providers,
  editMode,
  llmDraft,
  onLlmDraftChange,
  onNoteSubmit,
  crash,
}: {
  agent: RegisteredAgent;
  selected: boolean;
  expanded: boolean;
  providers: ProviderEntry[];
  editMode: "none" | "note" | "llm";
  llmDraft: string | null;
  onLlmDraftChange?: (value: string) => void;
  onNoteSubmit?: (value: string) => void;
  crash?: DaemonCrashInfo | null;
}): JSX.Element {
  const isActive = agent.status === "active";
  const isBlocked = agent.status === "blocked";
  const isDisabled = agent.status === "disabled";
  const isCrashed = !!crash;
  const dotColor = isCrashed
    ? theme.accent.danger
    : isBlocked
      ? theme.accent.danger
      : isDisabled
        ? theme.fg.muted
        : isActive
          ? theme.accent.success
          : theme.fg.muted;
  const dot = isCrashed
    ? theme.symbols.cross
    : isBlocked
      ? theme.symbols.cross
      : isActive
        ? theme.symbols.activeDot
        : theme.symbols.idleDot;
  const registryId =
    typeof agent.metadata?.registryId === "string"
      ? agent.metadata.registryId
      : agent.id;
  const lastSeen = agent.lastSeenAt ? formatTime(agent.lastSeenAt) : "never";
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={selected ? theme.accent.primary : theme.fg.muted}>
          {selected ? "▸ " : "  "}
        </Text>
        <Text color={dotColor}>{dot}</Text>{" "}
        <Text
          color={isDisabled ? theme.fg.muted : theme.accent.primary}
          dimColor={isDisabled}
        >
          {agent.id}
        </Text>{" "}
        <Text color={theme.fg.muted}>
          ({agent.displayName}) · {agent.transport}
          {isCrashed ? "" : isBlocked ? " · blocked" : ""}
          {isDisabled ? " · disabled" : ""}
          {isCrashed ? "" : " · last "}
          {isCrashed ? "" : lastSeen}
        </Text>
        {isCrashed && crash ? (
          <Text color={theme.accent.danger}>
            {" · daemon crashed (exit "}
            {crash.exitCode}
            {")"}
          </Text>
        ) : null}
      </Text>
      {isCrashed && crash && crash.stderrHint.length > 0 ? (
        <Box marginLeft={4}>
          <Text color={theme.fg.muted}>↳ </Text>
          <Text color={theme.accent.danger}>
            {crash.stderrHint.slice(0, 100)}
          </Text>
        </Box>
      ) : null}
      {expanded && (
        <Box
          flexDirection="column"
          marginLeft={2}
          marginBottom={1}
          paddingX={1}
          borderStyle={singleBorder()}
          borderDimColor
        >
          <Text color={theme.fg.muted}>registry id: {registryId}</Text>
          <Text color={theme.fg.muted}>status: {agent.status}</Text>
          <Text color={theme.fg.muted}>
            registered at: {formatTime(agent.registeredAt)}
          </Text>
          {typeof agent.metadata?.registryHomepage === "string" && (
            <Text color={theme.fg.muted}>
              homepage: {agent.metadata.registryHomepage}
            </Text>
          )}
          <Text color={theme.fg.muted}>
            mcp source key: --source {agent.id}
          </Text>
          {editMode === "note" ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.accent.warning}>
                responsibility (Enter saves · empty clears · Esc cancels):
              </Text>
              <TextInput
                defaultValue={agent.responsibilityNote ?? ""}
                placeholder="e.g. Code review and refactoring"
                onSubmit={(value) => onNoteSubmit?.(value)}
              />
            </Box>
          ) : (
            <Text color={theme.fg.muted}>
              responsibility: {agent.responsibilityNote ?? "(unset)"}
            </Text>
          )}
          {editMode === "llm" ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.accent.warning}>
                LLM provider (↑↓ to pick · Enter saves · Esc cancels):
              </Text>
              <Select
                options={providers.map((p) => ({
                  value: p.id,
                  label: p.name,
                }))}
                defaultValue={llmDraft ?? agent.llmProvider ?? undefined}
                onChange={(value) => onLlmDraftChange?.(value)}
              />
            </Box>
          ) : (
            <Text color={theme.fg.muted}>
              llm provider: {agent.llmProvider ?? "(unset)"}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}
