import { Box, Text } from "ink";
import { theme } from "../theme.js";

export function HelpOverlay(): JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={theme.accent.primary}
      paddingX={2}
      paddingY={1}
    >
      <Box justifyContent="center">
        <Text bold color={theme.accent.primary}>
          {theme.symbols.bullet} Foreman Help
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Section
          title="Navigation"
          rows={[
            ["c", "chat / test console"],
            ["l", "logs page"],
            ["p", "policy page"],
            ["s", "sessions page"],
            ["Esc", "back to dashboard"],
            ["q / Ctrl-C", "quit (with confirm)"],
          ]}
        />
        <Section
          title="Chat / test console"
          rows={[
            ["← →", "switch source agent"],
            ["i", "enter input mode"],
            ["Enter", "send through mediator (records audit log)"],
            ["Esc", "exit input mode / leave page"],
          ]}
        />
        <Section
          title="Approval modal"
          rows={[
            ["a / d", "allow once / deny"],
            ["A / D", "always allow / always deny"],
            ["r", "remember rule (allow)"],
            ["i", "inspect details"],
          ]}
        />
        <Section
          title="Logs page"
          rows={[
            ["/", "search (FTS5)"],
            ["1-4", "toggle filter: allowed / denied / ask / errored"],
            ["↑ ↓ / Enter", "select / expand row"],
            ["r", "replay request"],
            ["e", "export to file"],
          ]}
        />
      </Box>
      <Box marginTop={1} justifyContent="center">
        <Text color={theme.fg.muted}>
          {`docs: github.com/tuzlu07x/foreman  ·  press ? or Esc to close`}
        </Text>
      </Box>
    </Box>
  );
}

interface SectionProps {
  title: string;
  rows: ReadonlyArray<readonly [string, string]>;
}

function Section({ title, rows }: SectionProps): JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={theme.fg.emphasis}>
        {title}
      </Text>
      {rows.map(([key, label]) => (
        <Box key={key}>
          <Text>
            {"  "}
            <Text color={theme.accent.primary}>{padRight(key, 12)}</Text>{" "}
            <Text color={theme.fg.default}>{label}</Text>
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function padRight(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}
