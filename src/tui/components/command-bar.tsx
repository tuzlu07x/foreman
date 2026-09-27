import { Box, Text, useInput } from "ink";
import { type JSX, useRef, useState } from "react";
import { roundBorder, theme } from "../theme.js";
import { completeCommand, executeCommand, type CommandEnv } from "../tui-commands.js";

// The command console (#612): `:` opens it from any page. While open it
// takes over the page area — scrollback of this session's commands above,
// the input line below — and owns the keyboard.

const MAX_HISTORY = 50;
const MAX_SCROLLBACK = 400;

export interface ConsoleEntry {
  line: string;
  ok: boolean;
  output: string[];
}

export interface CommandBarProps {
  env: CommandEnv;
  onClose: () => void;
  width: number;
  /** Rows available for the whole console, input included. */
  height: number;
  /** Shared across openings so ↑ recalls earlier commands. */
  history: string[];
  onHistory: (next: string[]) => void;
  /** Output of this session's commands, kept while the console is closed. */
  scrollback: ConsoleEntry[];
  onScrollback: (next: ConsoleEntry[]) => void;
}

/** Flatten entries into display lines (exported for tests). */
export function consoleLines(entries: ConsoleEntry[]): Array<{ text: string; tone: "cmd" | "ok" | "error" }> {
  const out: Array<{ text: string; tone: "cmd" | "ok" | "error" }> = [];
  for (const e of entries) {
    out.push({ text: `› ${e.line}`, tone: "cmd" });
    for (const l of e.output) out.push({ text: l, tone: e.ok ? "ok" : "error" });
  }
  return out;
}

export function CommandBar({
  env,
  onClose,
  width,
  height,
  history,
  onHistory,
  scrollback,
  onScrollback,
}: CommandBarProps): JSX.Element {
  const [input, setInput] = useState("");
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  /** Lines scrolled up from the bottom. */
  const [scroll, setScroll] = useState(0);
  // The approval on screen when the current line was started: `approve`
  // must not land on a different one that replaced it while typing.
  const approvalAtStart = useRef<string | null>(null);
  const noteLineStart = (): void => {
    if (input === "") approvalAtStart.current = env.approvals.current();
  };

  const submit = async (raw: string = input): Promise<void> => {
    const line = raw.trim();
    if (!line) return;
    onHistory([line, ...history.filter((h) => h !== line)].slice(0, MAX_HISTORY));
    setHistoryIndex(null);
    setCandidates([]);
    setInput("");
    setScroll(0);
    setRunning(true);
    try {
      const result = await executeCommand(line, env, { approvalAtStart: approvalAtStart.current });
      if (result.clear) onScrollback([]);
      else onScrollback([...scrollback, { line, ok: result.ok, output: result.lines }].slice(-MAX_SCROLLBACK));
    } finally {
      setRunning(false);
    }
  };

  const lines = consoleLines(scrollback);
  // Frame (2) + input (1) + candidates (1) + hint (1).
  const viewRows = Math.max(3, height - 5);
  const maxScroll = Math.max(0, lines.length - viewRows);
  const offset = Math.min(scroll, maxScroll);
  const visible = lines.slice(Math.max(0, lines.length - viewRows - offset), lines.length - offset);

  useInput((ch, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.pageUp) {
      setScroll(Math.min(maxScroll, offset + viewRows - 1));
      return;
    }
    if (key.pageDown) {
      setScroll(Math.max(0, offset - (viewRows - 1)));
      return;
    }
    if (running) return;
    if (key.return) {
      void submit();
      return;
    }
    if (key.tab) {
      const completion = completeCommand(input, env);
      if (completion.line !== null) {
        noteLineStart();
        setInput(completion.line);
      }
      setCandidates(completion.candidates.length > 1 ? completion.candidates : []);
      return;
    }
    if (key.upArrow) {
      if (history.length === 0) return;
      const next = historyIndex === null ? 0 : Math.min(history.length - 1, historyIndex + 1);
      setHistoryIndex(next);
      noteLineStart();
      setInput(history[next]!);
      return;
    }
    if (key.downArrow) {
      if (historyIndex === null) return;
      const next = historyIndex - 1;
      setHistoryIndex(next < 0 ? null : next);
      setInput(next < 0 ? "" : history[next]!);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((v) => v.slice(0, -1));
      return;
    }
    if (key.ctrl && ch === "u") {
      setInput("");
      return;
    }
    if (key.ctrl && ch === "w") {
      setInput((v) => v.replace(/\S+\s*$/, ""));
      return;
    }
    if (key.ctrl && ch === "l") {
      onScrollback([]);
      return;
    }
    if (key.ctrl || key.meta || !ch) return;
    // Pasted (or fast-typed) text can arrive as one chunk, Enter included.
    const newline = ch.search(/[\r\n]/);
    if (newline !== -1) {
      noteLineStart();
      void submit(input + ch.slice(0, newline).replace(/[\u0000-\u001f\u007f]/g, ""));
      return;
    }
    const printable = ch.replace(/[\u0000-\u001f\u007f]/g, "");
    if (printable) {
      noteLineStart();
      setInput((v) => v + printable);
      setCandidates([]);
    }
  });

  const innerWidth = Math.max(20, width - 4);
  const clip = (t: string): string => (t.length > innerWidth ? `${t.slice(0, innerWidth - 1)}…` : t || " ");
  return (
    <Box flexDirection="column" width={width}>
      <Box
        flexDirection="column"
        borderStyle={roundBorder()}
        borderColor={theme.accent.primary}
        paddingX={1}
        height={viewRows + 2}
        justifyContent={lines.length === 0 ? "flex-start" : "flex-end"}
      >
        {lines.length === 0 ? (
          <Box flexDirection="column">
            <Text color={theme.accent.primary} bold>
              Command console
            </Text>
            <Text color={theme.fg.muted}>
              Talk to Foreman and your agents from here. A few things to try:
            </Text>
            <Text> </Text>
            {[
              ["status", "who is registered and running"],
              ["write <agent> <task>", "hand a task to an agent"],
              ["assign <department> <task>", "route through your org chart"],
              ["open inbox", "everything that needs your attention"],
              ["approve / deny", "decide the approval on screen"],
              ["help", "every command"],
            ].map(([cmd, what]) => (
              <Text key={cmd}>
                <Text color={theme.fg.emphasis}>{`  ${cmd!.padEnd(30)}`}</Text>
                <Text color={theme.fg.muted}>{what}</Text>
              </Text>
            ))}
          </Box>
        ) : (
          visible.map((l, i) => (
            <Text
              key={i}
              wrap="truncate-end"
              color={
                l.tone === "cmd"
                  ? theme.accent.primary
                  : l.tone === "error"
                    ? theme.accent.danger
                    : theme.fg.default
              }
              bold={l.tone === "cmd"}
            >
              {clip(l.text)}
            </Text>
          ))
        )}
      </Box>
      <Box paddingX={1}>
        <Text color={theme.accent.primary} bold>
          {"› "}
        </Text>
        <Text color={theme.fg.emphasis}>{input}</Text>
        <Text color={theme.accent.primary}>{running ? " …" : "█"}</Text>
      </Box>
      <Box paddingX={1}>
        {candidates.length > 0 ? (
          <Text color={theme.accent.info} wrap="truncate-end">
            {candidates.slice(0, 16).join("  ")}
          </Text>
        ) : (
          <Text color={theme.fg.muted} wrap="truncate-end">
            Enter run · Tab complete · ↑↓ history · PgUp/PgDn scroll{offset > 0 ? ` (${offset} up)` : ""} · Ctrl+L clear · Esc close
          </Text>
        )}
      </Box>
    </Box>
  );
}
