import { Box, Text } from "ink";
import { theme } from "../theme.js";

// =============================================================================
// Typography primitives (#234 — UX-2)
// =============================================================================
//
// Page-level building blocks for consistent visual hierarchy. Every page that
// renders into a panel uses `<PageHeader>` at the top; subheadings inside
// sections use `<Subheader>`; muted hints / footers use `<Caption>`. Dividers
// always look the same. Spacing is centralised so we don't have ad-hoc
// `marginTop={1}` everywhere.

export interface PageHeaderProps {
  /** Big bold title rendered in the brand accent colour. */
  title: string;
  /** Optional small text rendered next to / under the title. */
  subtitle?: string;
  /** Optional right-aligned status text (counts, summaries). */
  right?: string;
  /** Skip the divider rule under the header. */
  noDivider?: boolean;
}

export function PageHeader({
  title,
  subtitle,
  right,
  noDivider,
}: PageHeaderProps): JSX.Element {
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Box>
          <Text color={theme.accent.primary} bold>
            {title}
          </Text>
          {subtitle ? (
            <>
              <Text color={theme.fg.muted}>{"  "}</Text>
              <Text color={theme.fg.muted}>{subtitle}</Text>
            </>
          ) : null}
        </Box>
        {right ? <Text color={theme.fg.muted}>{right}</Text> : null}
      </Box>
      {noDivider ? null : <Divider />}
    </Box>
  );
}

export interface SubheaderProps {
  children: string;
}

/** Section subheader — bold, no colour (so it sits under the page H1 without
 *  competing for attention). */
export function Subheader({ children }: SubheaderProps): JSX.Element {
  return (
    <Text bold color={theme.fg.emphasis}>
      {children}
    </Text>
  );
}

export interface CaptionProps {
  children: React.ReactNode;
  /** Indent the caption (one level = 2 spaces). */
  indent?: number;
}

/** Muted caption — hint / footer / metadata text. */
export function Caption({ children, indent = 0 }: CaptionProps): JSX.Element {
  const pad = indent > 0 ? " ".repeat(indent * 2) : "";
  return (
    <Text color={theme.fg.muted}>
      {pad}
      {children}
    </Text>
  );
}

export interface DividerProps {
  /** Total characters wide. Defaults to 60 (matches the wizard / boot banner). */
  width?: number;
}

/** Horizontal rule in `fg.muted` — used under page headers and between
 *  sections. Defaults to 60 characters which fits comfortably in both the
 *  dashboard panels and full-page layouts.
 *
 *  Width is clamped to [1, 200] so callers can pass derived values
 *  (e.g. `Math.min(60, termCols - 2)`) without worrying about negatives
 *  or NaN crashing the render — `String.repeat` throws on those (#282). */
export function Divider({ width = 60 }: DividerProps): JSX.Element {
  const safeWidth = Number.isFinite(width)
    ? Math.max(1, Math.min(200, Math.floor(width)))
    : 60;
  const ch = "─";
  return <Text color={theme.fg.muted}>{ch.repeat(safeWidth)}</Text>;
}

export interface SectionGapProps {
  /** Spacing units (1 unit = 1 blank line). Defaults to 1. */
  rows?: number;
}

/** Vertical spacer — replaces ad-hoc `<Box marginTop={1}>` boilerplate so the
 *  whole TUI uses the same rhythm. */
export function SectionGap({ rows = 1 }: SectionGapProps): JSX.Element {
  return <Box marginTop={rows} />;
}

export interface KeyValueRowProps {
  /** Left-aligned label. */
  label: string;
  /** Right-aligned value (or any child). */
  value: React.ReactNode;
  /** Width for the label column — values right-align past this. */
  labelWidth?: number;
}

/** Two-column row used in boot banner / settings tile / wizard summary.
 *  Label sits left, value right-aligns within `labelWidth + value` cells. */
export function KeyValueRow({
  label,
  value,
  labelWidth = 18,
}: KeyValueRowProps): JSX.Element {
  const padded =
    label.length >= labelWidth
      ? `${label} `
      : label + " ".repeat(Math.max(1, labelWidth - label.length));
  return (
    <Text>
      <Text color={theme.fg.default}>{padded}</Text>
      <Text color={theme.fg.muted}>{value}</Text>
    </Text>
  );
}
