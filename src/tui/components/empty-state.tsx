import { Box, Text } from "ink";
import { theme } from "../theme.js";

// =============================================================================
// EmptyState (#234 UX-5)
// =============================================================================
//
// Inviting placeholder rendered when a page has nothing to show. Replaces the
// flat `(no X)` lines with a clear title + body + actionable hints so a new
// user knows what to do next instead of staring at a parenthetical.
//
// Layout:
//   ▸ Title (accent.primary, bold)
//     One- or two-line body (fg.default)
//
//     suggested commands:
//       → foreman setup
//       → foreman agent add hermes --type hermes
//
//     [r] retry / [Esc] back

export interface EmptyStateProps {
  title: string;
  /** One- or two-line description of what's empty + why. */
  body?: string;
  /** Concrete next steps — usually `foreman …` shell commands. */
  commands?: string[];
  /** Hotkey hints rendered at the bottom (`[r]` retry / `[Esc]` back). */
  hotkeys?: string[];
}

export function EmptyState({
  title,
  body,
  commands,
  hotkeys,
}: EmptyStateProps): JSX.Element {
  return (
    <Box flexDirection="column" paddingY={1} paddingX={2}>
      <Text bold color={theme.accent.primary}>
        {theme.symbols.bullet} {title}
      </Text>
      {body ? (
        <Box marginTop={1}>
          <Text color={theme.fg.default}>{body}</Text>
        </Box>
      ) : null}
      {commands && commands.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.fg.muted}>Try:</Text>
          {commands.map((c, i) => (
            <Text key={i}>
              {"  "}
              <Text color={theme.accent.primary}>{theme.symbols.arrow}</Text>{" "}
              <Text color={theme.fg.emphasis}>{c}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
      {hotkeys && hotkeys.length > 0 ? (
        <Box marginTop={1}>
          <Text color={theme.fg.muted}>{hotkeys.join("  ·  ")}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
