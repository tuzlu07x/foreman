import { TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { RegisteredAgent } from "../../core/registry.js";
import { useDashboardServices } from "../dashboard-context.js";
import { formatTime } from "../format.js";
import { singleBorder, theme } from "../theme.js";
import { EmptyState } from "../components/empty-state.js";

export interface ChatPageProps {
  selectedAgentIdx: number;
  inputMode: boolean;
  inputBuffer: string;
  setInputBuffer: (next: string) => void;
  scrollback: ChatScrollbackEntry[];
  onSubmit: (raw: string) => void;
  notice: string | null;
}

export interface ChatScrollbackEntry {
  id: string;
  ts: number;
  sourceAgent: string;
  rawPrompt: string;
  parsedTool: string | null;
  parsedArgs: Record<string, unknown> | null;
  decision: "allowed" | "denied" | "error";
  decidedBy: string;
  riskScore: number;
  riskReasons: string[];
  durationMs: number;
}

const VISIBLE_LINES = 14;

export function ChatPage({
  selectedAgentIdx,
  inputMode,
  inputBuffer,
  setInputBuffer,
  scrollback,
  onSubmit,
  notice,
}: ChatPageProps): JSX.Element {
  const { registry } = useDashboardServices();
  const [agents, setAgents] = useState<RegisteredAgent[]>(() => registry.list());
  useEffect(() => {
    const interval = setInterval(() => setAgents(registry.list()), 2000);
    return () => clearInterval(interval);
  }, [registry]);

  const safeIdx = Math.max(0, Math.min(selectedAgentIdx, agents.length - 1));
  const picked = agents[safeIdx];
  const visible = scrollback.slice(-VISIBLE_LINES);

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
          Chat / Test console
        </Text>
        <Text color={theme.fg.muted}>{scrollback.length} entries</Text>
      </Box>

      <Box marginTop={1}>
        {agents.length === 0 ? (
          <EmptyState
            title="No agents registered yet"
            body="The chat / test console drives a call through the mediator as if one of your agents made it. Add an agent first; you can pick which one drives each exchange."
            commands={[
              "foreman setup",
              "foreman agent add my-claude --type claude-code",
            ]}
            hotkeys={["[Esc] back to dashboard"]}
          />
        ) : (
          <Text>
            Agent: <Text color={theme.fg.muted}>◀</Text>{" "}
            <Text color={theme.accent.primary} bold>
              {picked?.id ?? "?"}
            </Text>{" "}
            <Text color={theme.fg.muted}>▶ ({picked?.displayName})</Text>
          </Text>
        )}
      </Box>

      <Box flexDirection="column" marginTop={1} flexGrow={1}>
        {visible.length === 0 && agents.length > 0 ? (
          <EmptyState
            title="No exchanges yet"
            body="Type a tool name + optional JSON args, press Enter to send through Foreman's mediator. Every call is audited; risky ones open the approval modal."
            commands={[
              'read_file {"path": ".env"}',
              'shell_exec {"cmd": "ls"}',
            ]}
            hotkeys={["[i] input mode · [← →] switch agent · [Esc] back"]}
          />
        ) : (
          visible.map((entry) => <ScrollbackRow key={entry.id} entry={entry} />)
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.fg.muted}>
          Examples: <Text color={theme.accent.primary}>read_file {`{"path": ".env"}`}</Text>{" "}
          · <Text color={theme.accent.primary}>shell_exec {`{"cmd": "ls"}`}</Text>{" "}
          · <Text color={theme.accent.primary}>secrets/get {`{"name": "anthropic-key"}`}</Text>
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.accent.primary}>{"> "}</Text>
        {inputMode ? (
          <TextInput
            placeholder="tool_name [json args]"
            defaultValue={inputBuffer}
            onChange={setInputBuffer}
            onSubmit={onSubmit}
          />
        ) : (
          <Text color={theme.fg.muted}>
            (press <Text color={theme.accent.primary}>i</Text> to start typing,{" "}
            <Text color={theme.accent.primary}>Esc</Text> exits input)
          </Text>
        )}
      </Box>

      {notice && (
        <Box marginTop={1}>
          <Text color={theme.accent.warning}>{notice}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.fg.muted}>{"─".repeat(60)}</Text>
      </Box>
      <Text color={theme.fg.muted}>
        [←→] switch agent · [i] enter input · [Enter] send · [Esc] back
      </Text>
    </Box>
  );
}

function ScrollbackRow({ entry }: { entry: ChatScrollbackEntry }): JSX.Element {
  const decisionColor =
    entry.decision === "allowed"
      ? theme.accent.success
      : entry.decision === "denied"
        ? theme.accent.danger
        : theme.accent.warning;
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.fg.muted}>[{formatTime(entry.ts)}]</Text>{" "}
        <Text color={theme.accent.primary}>{entry.sourceAgent}</Text>{" "}
        {entry.parsedTool ? (
          <Text>{entry.parsedTool}</Text>
        ) : (
          <Text color={theme.fg.muted}>{entry.rawPrompt}</Text>
        )}{" "}
        <Text color={decisionColor}>
          {entry.decision === "allowed"
            ? "✓"
            : entry.decision === "denied"
              ? "✗"
              : "⚠"}{" "}
          {entry.decision}
        </Text>{" "}
        <Text color={theme.fg.muted}>
          · {entry.decidedBy} · {entry.durationMs}ms
          {entry.riskScore ? ` · risk ${entry.riskScore}` : ""}
        </Text>
      </Text>
      {entry.riskReasons.length > 0 && (
        <Box marginLeft={2}>
          <Text color={theme.fg.muted}>reasons: {entry.riskReasons.join(", ")}</Text>
        </Box>
      )}
    </Box>
  );
}

export function parseChatPrompt(raw: string): {
  tool: string | null;
  args: Record<string, unknown> | null;
} {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { tool: null, args: null };
  const braceIdx = trimmed.indexOf("{");
  if (braceIdx === -1) {
    // No JSON args — entire input is the tool name.
    return { tool: trimmed, args: {} };
  }
  const tool = trimmed.slice(0, braceIdx).trim();
  const jsonStr = trimmed.slice(braceIdx).trim();
  try {
    const parsed = JSON.parse(jsonStr) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { tool: tool || null, args: parsed as Record<string, unknown> };
    }
  } catch {
    /* fall through */
  }
  return { tool: tool || null, args: null };
}
