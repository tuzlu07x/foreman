import { Box, Text } from 'ink'
import { useEffect, useState } from 'react'
import type { ApprovalRequest } from '../../core/approval.js'
import type { RiskBucket } from '../../core/risk-rules/types.js'
import { useDashboardState } from '../use-dashboard-state.js'
import {
  buildInspectLines,
  clampOffset,
  type InspectLine,
  type LineColor,
} from '../inspect-content.js'
import { doubleBorder, theme } from '../theme.js'

function bucketColor(bucket: RiskBucket | undefined): string {
  switch (bucket) {
    case 'critical':
      return theme.accent.danger
    case 'high':
      return theme.accent.primary
    case 'medium':
      return theme.accent.warning
    case 'low':
      return theme.accent.success
    default:
      return theme.accent.warning
  }
}

const VISIBLE_LINES = 22

export interface InspectViewProps {
  request: ApprovalRequest
  offset: number
  setOffset: (next: number) => void
  remainingSeconds: number
}

export function InspectView({
  request,
  offset,
  setOffset,
  remainingSeconds,
}: InspectViewProps): JSX.Element {
  const { recentRequests } = useDashboardState()
  const lines = buildInspectLines({ request, recentRequests })
  const total = lines.length
  const clamped = clampOffset(offset, total, VISIBLE_LINES)

  useEffect(() => {
    if (clamped !== offset) setOffset(clamped)
  }, [clamped, offset, setOffset])

  const visible = lines.slice(clamped, clamped + VISIBLE_LINES)
  const atTop = clamped === 0
  const atBottom = clamped + VISIBLE_LINES >= total

  const color = bucketColor(request.riskBucket)
  return (
    <Box
      flexDirection="column"
      borderStyle={doubleBorder()}
      borderColor={color}
      paddingX={2}
    >
      <Box justifyContent="space-between">
        <Text bold color={color}>
          {theme.symbols.warn} Inspecting{request.riskBucket ? ` · ${request.riskBucket}` : ''}
        </Text>
        <Text color={theme.fg.muted}>
          {clamped + 1}–{Math.min(clamped + VISIBLE_LINES, total)} / {total}
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {visible.map((line, i) => (
          <InspectRow key={`${clamped}-${i}`} line={line} />
        ))}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.fg.muted}>{'─'.repeat(60)}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={theme.fg.muted}>
          {scrollHint(atTop, atBottom)} · [Esc] back · [a/d] decide
        </Text>
        <TimerLabel remainingSeconds={remainingSeconds} />
      </Box>
    </Box>
  )
}

function InspectRow({ line }: { line: InspectLine }): JSX.Element {
  const color = colorFor(line.color)
  return (
    <Text color={color} bold={line.bold} italic={line.italic}>
      {line.text === '' ? ' ' : line.text}
    </Text>
  )
}

function colorFor(color?: LineColor): string | undefined {
  switch (color) {
    case 'muted':
      return theme.fg.muted
    case 'warning':
      return theme.accent.warning
    case 'primary':
      return theme.accent.primary
    case 'success':
      return theme.accent.success
    case 'danger':
      return theme.accent.danger
    default:
      return undefined
  }
}

function scrollHint(atTop: boolean, atBottom: boolean): string {
  if (atTop && atBottom) return 'no scroll'
  if (atTop) return '↓ PgDn'
  if (atBottom) return '↑ PgUp'
  return '↑↓ PgUp/Dn'
}

function TimerLabel({
  remainingSeconds,
}: {
  remainingSeconds: number
}): JSX.Element {
  const color =
    remainingSeconds <= 10
      ? theme.accent.danger
      : remainingSeconds <= 30
        ? theme.accent.warning
        : theme.fg.muted
  return (
    <Text color={color}>
      {theme.symbols.timer} {remainingSeconds}s left
    </Text>
  )
}

// useState exported so App can drive it
export function useInspectOffsetState(): [number, (next: number) => void] {
  return useState(0)
}
