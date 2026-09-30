import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { type JSX, useEffect, useState } from "react";
import type { ControlCommand, Request } from "../../db/schema.js";
import {
  displayWidth,
  fitWidth,
  formatDuration,
  oneLine,
  relativeTime,
  statusIconFor,
  safe,
  summariseTool,
  targetLabel,
} from "../format.js";
import { useTerminalSize } from "../hooks.js";
import { roundBorder, theme } from "../theme.js";
import { useDashboardState } from "../use-dashboard-state.js";

const FADE_DURATION_MS = 200;

export interface ActivityFeedProps {
  width?: string;
  /** The feed's share of the terminal when a parent box sets its width
   *  (the wide layout puts it in a 60% column), so rows are fitted to the
   *  columns they really have. `width` wins when both are set. */
  share?: string;
  minimal?: boolean;
}

// #498 — Unified Activity row type so request and control_command rows
// can interleave chronologically.
type FeedItem =
  | { kind: "request"; createdAt: number; row: Request }
  | { kind: "control"; createdAt: number; row: ControlCommand };

export function ActivityFeed({
  width,
  share,
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
  const { cols } = useTerminalSize();
  const rowWidth = feedRowWidth(cols, width ?? share, minimal === true);

  // The page gives the feed a fixed height. Rows keep their own height
  // (flexShrink 0) and the frame clips what doesn't fit (overflow hidden),
  // so the oldest rows drop off the bottom. Left to shrink, Yoga squeezes
  // every two-line row into one and draws each row over the next.
  const inner = (
    <Box flexDirection="column" flexShrink={0}>
      {pendingRequests.map((p) => (
        <PendingRow key={p.requestId} pending={p} />
      ))}
      {visible.length === 0 && pendingRequests.length === 0 ? (
        <Box flexDirection="column">
          <Text color={theme.fg.muted}>Quiet so far.</Text>
          <Text color={theme.fg.muted}>
            Every tool call your agents make shows up here as it happens —
          </Text>
          <Text color={theme.fg.muted}>allowed, asked or blocked, with the reason.</Text>
        </Box>
      ) : (
        visible.map((item) =>
          item.kind === "request" ? (
            <ActivityRow key={`r${item.row.id}`} request={item.row} rowWidth={rowWidth} />
          ) : (
            <ControlRow key={`c${item.row.id}`} command={item.row} rowWidth={rowWidth} />
          ),
        )
      )}
    </Box>
  );

  if (minimal) {
    return (
      <Box flexDirection="column" paddingX={1} overflow="hidden">
        <Box flexShrink={0}>
          <Text color={theme.accent.primary}>Activity</Text>
        </Box>
        {inner}
      </Box>
    );
  }

  return (
    <Box
      width={width}
      flexDirection="column"
      borderStyle={roundBorder()}
      borderDimColor
      paddingX={1}
      flexGrow={1}
      overflow="hidden"
    >
      <Box flexShrink={0}>
        <Text color={theme.accent.primary}>Activity</Text>
      </Box>
      {inner}
    </Box>
  );
}

/** Columns a row may use: the feed's share of the terminal, less its
 *  frame (border + padding), less one column of slack for rounding. */
export function feedRowWidth(
  cols: number,
  width: string | undefined,
  minimal: boolean,
): number {
  const pct = width?.endsWith("%") ? Number.parseFloat(width) : Number.NaN;
  const outer = Number.isFinite(pct) ? Math.floor((cols * pct) / 100) : cols;
  return Math.max(20, outer - (minimal ? 2 : 4) - 1);
}

function ActivityRow({
  request,
  rowWidth,
}: {
  request: Request;
  rowWidth: number;
}): JSX.Element {
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
  const when = relativeTime(request.createdAt);
  const who = targetLabel(request.sourceAgent, request.targetAgent);
  // One line per row: the call gets what the time and agent leave, and a
  // long path gives up its middle, not its file name.
  const callWidth = Math.max(8, rowWidth - displayWidth(when) - 3 - displayWidth(who) - 1);
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text color={headerColor} wrap="truncate-end">
        <Text color={theme.fg.muted}>{when}</Text>
        <Text color={theme.fg.muted}> · </Text>
        <Text color={faded ? theme.accent.primary : theme.fg.muted}>
          {who}
        </Text>{" "}
        <Text bold={faded}>
          {summariseTool(request.targetTool, request.args, callWidth)}
        </Text>
      </Text>
      <Text wrap="truncate-end">
        {"  "}
        <Text color={faded ? toneColor : theme.fg.muted}>{status.icon}</Text>{" "}
        <Text color={theme.fg.muted}>
          {request.decision} · {safe(request.decidedBy ?? "pending")}
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
function ControlRow({
  command,
  rowWidth,
}: {
  command: ControlCommand;
  rowWidth: number;
}): JSX.Element {
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
  const when = relativeTime(command.createdAt);
  const who = safe(command.sourceAgent ?? "");
  // Same budget as a request row: the summary gets what the time and agent
  // leave, measured in terminal columns (an emoji or CJK character is two).
  const summaryWidth = Math.max(8, rowWidth - displayWidth(when) - 3 - displayWidth(who) - 1);
  const summary = fitWidth(summariseControlCommand(command), summaryWidth);
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text color={headerColor} wrap="truncate-end">
        <Text color={theme.fg.muted}>{when}</Text>
        <Text color={theme.fg.muted}> · </Text>
        <Text color={faded ? theme.accent.primary : theme.fg.muted}>
          {who}
        </Text>{" "}
        <Text bold={faded}>{summary}</Text>
      </Text>
      <Text wrap="truncate-end">
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

// Compact one-line summary of the directive: "write codex: review PR…"
// or "stop" / "llm switch openai gpt-4o-mini". Agent-supplied text is
// flattened to one line (line breaks as ⏎, hidden characters made
// visible); the caller fits it to the row.
export function summariseControlCommand(command: ControlCommand): string {
  let args: string[];
  try {
    const parsed = JSON.parse(command.args);
    args = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    args = [];
  }
  if (command.command === "write") {
    const target = oneLine(args[0] ?? "?");
    const body = oneLine(args.slice(1).join(" "));
    return `write ${target}: ${fitWidth(body, 40)}`;
  }
  if (command.command === "llm-switch") {
    return oneLine(`llm switch ${args.join(" ")}`.trim());
  }
  if (command.command === "llm-budget") {
    return oneLine(`llm budget ${args.join(" ")}`.trim());
  }
  if (command.command === "stop") return "stop";
  return oneLine(`${command.command} ${args.join(" ")}`.trim());
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
      <Text color={theme.accent.info} wrap="truncate-end">
        {safe(pending.sourceAgent)}
        {pending.targetTool ? ` → ${safe(pending.targetTool)}` : ""}{" "}
        <Text color={theme.fg.muted}>…</Text>
      </Text>
    </Box>
  );
}
