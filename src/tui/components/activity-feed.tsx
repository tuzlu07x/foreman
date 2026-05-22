import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useEffect, useState } from "react";
import type { ControlCommand, Request } from "../../db/schema.js";
import {
  formatDuration,
  relativeTime,
  statusIconFor,
  summariseTool,
  targetLabel,
} from "../format.js";
import { singleBorder, theme } from "../theme.js";
import { useDashboardState } from "../use-dashboard-state.js";

const FADE_DURATION_MS = 200;

export interface ActivityFeedProps {
  width?: string;
  minimal?: boolean;
}

// #498 — Unified Activity row type so request and control_command rows
// can interleave chronologically.
type FeedItem =
  | { kind: "request"; createdAt: number; row: Request }
  | { kind: "control"; createdAt: number; row: ControlCommand };

export function ActivityFeed({
  width,
  minimal,
}: ActivityFeedProps): JSX.Element {
  const { recentRequests, recentControlCommands, pendingRequests } =
    useDashboardState();
  // #498 — Merge requests + control_commands into one chronological
  // stream so the user sees orchestration directives (foreman write
  // …, stop, llm switch) right next to policy approval activity. The
  // ActivityRow / ControlRow components handle the per-kind rendering.
  const merged: FeedItem[] = [
    ...recentRequests.map(
      (r): FeedItem => ({ kind: "request", createdAt: r.createdAt, row: r }),
    ),
    ...recentControlCommands.map(
      (c): FeedItem => ({ kind: "control", createdAt: c.createdAt, row: c }),
    ),
  ].sort((a, b) => b.createdAt - a.createdAt);
  const visible = minimal ? merged.slice(0, 5) : merged.slice(0, 20);

  const inner = (
    <Box flexDirection="column">
      {pendingRequests.map((p) => (
        <PendingRow key={p.requestId} pending={p} />
      ))}
      {visible.length === 0 && pendingRequests.length === 0 ? (
        <Text color={theme.fg.muted}>(no activity yet)</Text>
      ) : (
        visible.map((item) =>
          item.kind === "request" ? (
            <ActivityRow key={`r${item.row.id}`} request={item.row} />
          ) : (
            <ControlRow key={`c${item.row.id}`} command={item.row} />
          ),
        )
      )}
    </Box>
  );

  if (minimal) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.accent.primary}>Activity</Text>
        {inner}
      </Box>
    );
  }

  return (
    <Box
      width={width}
      flexDirection="column"
      borderStyle={singleBorder()}
      borderDimColor
      paddingX={1}
      flexGrow={1}
    >
      <Text color={theme.accent.primary}>Activity</Text>
      {inner}
    </Box>
  );
}

function ActivityRow({ request }: { request: Request }): JSX.Element {
  const status = statusIconFor(request.decision);
  const toneColor =
    status.tone === "success"
      ? theme.accent.success
      : status.tone === "danger"
        ? theme.accent.danger
        : theme.accent.warning;
  // 200ms fade-in: first render shows the row in muted fg, then it
  // promotes to the default fg once the timer fires (TUI spec §8.1).
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setFaded(true), FADE_DURATION_MS);
    return () => clearTimeout(t);
  }, []);
  const headerColor = faded ? theme.fg.default : theme.fg.muted;
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text color={headerColor}>
        <Text color={theme.fg.muted}>{relativeTime(request.createdAt)}</Text>
        <Text color={theme.fg.muted}> · </Text>
        <Text color={faded ? theme.accent.primary : theme.fg.muted}>
          {targetLabel(request.sourceAgent, request.targetAgent)}
        </Text>{" "}
        <Text bold={faded}>
          {summariseTool(request.targetTool, request.args)}
        </Text>
      </Text>
      <Text>
        {"  "}
        <Text color={faded ? toneColor : theme.fg.muted}>{status.icon}</Text>{" "}
        <Text color={theme.fg.muted}>
          {request.decision} · {request.decidedBy ?? "pending"}
          {request.durationMs !== null
            ? ` · ${formatDuration(request.durationMs)}`
            : ""}
        </Text>
      </Text>
    </Box>
  );
}

// #498 — Renders a control_commands row in the Activity feed. Mirrors
// ActivityRow's fade-in + alignment so the merged stream looks
// consistent regardless of source. Status glyph reflects the
// orchestration outcome (applied / failed / rejected / pending).
function ControlRow({ command }: { command: ControlCommand }): JSX.Element {
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setFaded(true), FADE_DURATION_MS);
    return () => clearTimeout(t);
  }, []);
  const { icon, tone } = controlStatusIconFor(command.status);
  const toneColor =
    tone === "success"
      ? theme.accent.success
      : tone === "danger"
        ? theme.accent.danger
        : tone === "warning"
          ? theme.accent.warning
          : theme.accent.info;
  const headerColor = faded ? theme.fg.default : theme.fg.muted;
  const summary = summariseControlCommand(command);
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text color={headerColor}>
        <Text color={theme.fg.muted}>{relativeTime(command.createdAt)}</Text>
        <Text color={theme.fg.muted}> · </Text>
        <Text color={faded ? theme.accent.primary : theme.fg.muted}>
          {command.sourceAgent}
        </Text>{" "}
        <Text bold={faded}>{summary}</Text>
      </Text>
      <Text>
        {"  "}
        <Text color={faded ? toneColor : theme.fg.muted}>{icon}</Text>{" "}
        <Text color={theme.fg.muted}>
          {command.status}
          {command.appliedAt !== null
            ? ` · ${formatDuration(command.appliedAt - command.createdAt)}`
            : ""}
          {" · id="}
          {command.id}
        </Text>
      </Text>
    </Box>
  );
}

// Compact one-line summary of the directive: "write codex \"review PR…\""
// or "stop" / "llm switch openai gpt-4o-mini". Truncates the write
// message to keep the row to one terminal line.
function summariseControlCommand(command: ControlCommand): string {
  let args: string[];
  try {
    const parsed = JSON.parse(command.args);
    args = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    args = [];
  }
  if (command.command === "write") {
    const target = args[0] ?? "?";
    const body = args.slice(1).join(" ");
    const preview = body.length > 40 ? `${body.slice(0, 37)}…` : body;
    return `write ${target}: ${preview}`;
  }
  if (command.command === "llm-switch") {
    return `llm switch ${args.join(" ")}`.trim();
  }
  if (command.command === "llm-budget") {
    return `llm budget ${args.join(" ")}`.trim();
  }
  if (command.command === "stop") return "stop";
  return `${command.command} ${args.join(" ")}`.trim();
}

function controlStatusIconFor(status: ControlCommand["status"]): {
  icon: string;
  tone: "success" | "danger" | "warning" | "info";
} {
  switch (status) {
    case "applied":
      return { icon: "✓", tone: "success" };
    case "failed":
      return { icon: "✗", tone: "danger" };
    case "rejected":
      return { icon: "⊘", tone: "warning" };
    default:
      return { icon: "…", tone: "info" };
  }
}

function PendingRow({
  pending,
}: {
  pending: { requestId: string; sourceAgent: string; targetTool?: string };
}): JSX.Element {
  return (
    <Box flexDirection="row" gap={1}>
      <Spinner />
      <Text color={theme.accent.info}>
        {pending.sourceAgent}
        {pending.targetTool ? ` → ${pending.targetTool}` : ""}{" "}
        <Text color={theme.fg.muted}>…</Text>
      </Text>
    </Box>
  );
}
