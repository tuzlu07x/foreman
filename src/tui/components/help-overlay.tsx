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
            ["h / ?", "open / close this help overlay"],
            ["c", "chat / test console"],
            ["g", "settings page (identity, policy, wizard)"],
            ["k", "keys (secrets) page"],
            ["a", "agents page"],
            ["v", "LLM providers page"],
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
          title="Settings page"
          rows={[
            ["e", "edit Foreman SOUL.md (agent identity)"],
            ["p", "edit policy.yaml"],
            ["P", "open Policy page (read-only view)"],
            ["w", "show re-run wizard instructions"],
          ]}
        />
        <Section
          title="Secrets page"
          rows={[
            ["↑ ↓ / Enter", "select / expand row"],
            ["v", "reveal value (auto-hides after 10s)"],
            ["r", "rotate value (inline password input)"],
            ["d", "remove secret"],
          ]}
        />
        <Section
          title="Agents page"
          rows={[
            ["↑ ↓ / Enter", "select / expand row"],
            ["N", "edit responsibility note (TextInput)"],
            ["L", "change LLM provider (Select · multi-provider only)"],
            ["d", "disable (pause — config preserved)"],
            ["e", "enable (resume from disabled)"],
            ["b", "block / unblock (malicious flag)"],
            ["r", "remove (hard delete + uninstall path)"],
            ["R", "regenerate Ed25519 keypair (shown once)"],
          ]}
        />
        <Section
          title="LLM Providers page"
          rows={[
            ["↑ ↓", "navigate (configured + available rows)"],
            ["n", "configure the selected available provider"],
            ["r", "rotate the selected configured provider's value"],
            ["d", "remove the selected configured provider"],
            ["s", "show value for 10s (auto-hides)"],
          ]}
        />
        <Section
          title="Approval modal"
          rows={[
            ["a / d", "allow once / deny"],
            ["A / D", "always allow / always deny (remember as rule)"],
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
          {`docs: github.com/tuzlu07x/foreman  ·  press h / ? / Esc to close`}
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
