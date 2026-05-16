import { Box, Text } from "ink";
import type { ApprovalRequest } from "../../core/approval.js";
import type {
  RiskBucket,
  RiskCategory,
  RiskFactor,
} from "../../core/risk-rules/types.js";
import { explain } from "../reason-explanations.js";
import { doubleBorder, theme } from "../theme.js";

export type ResolvedBy = "user" | "timeout";

export interface ApprovalResolution {
  decision: "allowed" | "denied";
  remember?: "allow" | "deny";
}

export interface ApprovalModalProps {
  request: ApprovalRequest;
  remainingSeconds: number;
}

const CATEGORY_ORDER: RiskCategory[] = [
  "secret",
  "shell",
  "network",
  "injection",
  "loop",
  "structural",
];

const CATEGORY_LABELS: Record<RiskCategory, string> = {
  secret: "Secret-related",
  shell: "Shell execution",
  network: "Network outbound",
  injection: "Prompt injection",
  loop: "Loop / anomaly",
  structural: "Structural",
};

const CATEGORY_ICONS: Record<RiskCategory, string> = {
  secret: "🔒",
  shell: "⌘",
  network: "🌐",
  injection: "💉",
  loop: "🔁",
  structural: "🧭",
};

const BUCKET_LABELS: Record<RiskBucket, string> = {
  low: "LOW RISK",
  medium: "MEDIUM RISK",
  high: "HIGH RISK",
  critical: "CRITICAL RISK",
};

function bucketColor(bucket: RiskBucket): string {
  switch (bucket) {
    case "critical":
      return theme.accent.danger;
    case "high":
      return theme.accent.primary;
    case "medium":
      return theme.accent.warning;
    case "low":
    default:
      return theme.accent.success;
  }
}

export function ApprovalModal({
  request,
  remainingSeconds,
}: ApprovalModalProps): JSX.Element {
  const bucket: RiskBucket = request.riskBucket ?? "medium";
  const borderColor = bucketColor(bucket);
  const grouped = groupFactors(request.riskFactors ?? []);
  const hasFactors = grouped.length > 0;

  return (
    <Box
      flexDirection="column"
      borderStyle={doubleBorder()}
      borderColor={borderColor}
      paddingX={2}
      paddingY={0}
    >
      <ModalHeader
        bucket={bucket}
        bucketColor={borderColor}
        riskScore={request.riskScore}
      />
      <Box marginTop={1}>
        <Text>
          <Text color={theme.accent.primary}>{request.sourceAgent}</Text>
          {request.targetAgent ? (
            <>
              {"  →  "}
              <Text color={theme.accent.primary}>{request.targetAgent}</Text>
            </>
          ) : null}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text>
          {"    "}
          <Text bold>{request.targetTool ?? "(no tool)"}</Text>
          <Text>({renderArgs(request.args)})</Text>
        </Text>
      </Box>

      {hasFactors ? (
        <Box flexDirection="column" marginTop={1}>
          {grouped.map((group) => (
            <FactorGroup
              key={group.category}
              category={group.category}
              factors={group.factors}
              totalPoints={group.totalPoints}
            />
          ))}
        </Box>
      ) : request.riskReasons.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.fg.muted}>Reasons:</Text>
          {request.riskReasons.map((r) => (
            <Text key={r}>
              {"    "}
              <Text color={borderColor}>{theme.symbols.reason}</Text> {r}
              {explain(r) ? (
                <Text color={theme.fg.muted}>{`  (${explain(r)})`}</Text>
              ) : null}
            </Text>
          ))}
        </Box>
      ) : null}

      {request.context ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.fg.muted}>Context:</Text>
          <Text italic color={theme.fg.muted}>
            {'    "'}
            {request.context}
            {'"'}
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={theme.fg.muted}>{"─".repeat(60)}</Text>
      </Box>

      <HotkeyRow />

      <Box marginTop={1} justifyContent="flex-end">
        <TimerLabel remainingSeconds={remainingSeconds} />
      </Box>
    </Box>
  );
}

function ModalHeader({
  bucket,
  bucketColor,
  riskScore,
}: {
  bucket: RiskBucket;
  bucketColor: string;
  riskScore: number;
}): JSX.Element {
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="column">
        <Text>{"   ___"}</Text>
        <Text>
          {"  (o.o)  "}
          <Text bold color={bucketColor}>
            {theme.symbols.warn} {BUCKET_LABELS[bucket]}
          </Text>
        </Text>
        <Text>{"   \\_/"}</Text>
      </Box>
      <Text color={bucketColor}>
        score <Text bold>{riskScore}</Text>/100
      </Text>
    </Box>
  );
}

interface FactorGroupEntry {
  category: RiskCategory;
  factors: RiskFactor[];
  totalPoints: number;
}

function groupFactors(factors: RiskFactor[]): FactorGroupEntry[] {
  const map = new Map<RiskCategory, RiskFactor[]>();
  for (const f of factors) {
    const existing = map.get(f.category) ?? [];
    existing.push(f);
    map.set(f.category, existing);
  }
  const groups: FactorGroupEntry[] = [];
  for (const category of CATEGORY_ORDER) {
    const bucket = map.get(category);
    if (!bucket || bucket.length === 0) continue;
    groups.push({
      category,
      factors: bucket,
      totalPoints: bucket.reduce((s, f) => s + f.points, 0),
    });
  }
  return groups;
}

function FactorGroup({
  category,
  factors,
  totalPoints,
}: FactorGroupEntry): JSX.Element {
  const sign = totalPoints >= 0 ? "+" : "";
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={theme.accent.warning}>
          {CATEGORY_ICONS[category]} {CATEGORY_LABELS[category]}
        </Text>{" "}
        <Text color={theme.fg.muted}>
          ({sign}
          {totalPoints} pts)
        </Text>
      </Text>
      {factors.map((f, i) => (
        <FactorLine key={`${f.rule}-${i}`} factor={f} />
      ))}
    </Box>
  );
}

function FactorLine({ factor }: { factor: RiskFactor }): JSX.Element {
  const sign = factor.points >= 0 ? "+" : "";
  return (
    <Box flexDirection="column">
      <Text>
        {"    "}
        <Text color={theme.fg.muted}>
          {sign}
          {factor.points.toString().padStart(3, " ")}
        </Text>{" "}
        {factor.reason}
      </Text>
      {factor.evidence ? (
        <Text color={theme.fg.muted}>
          {"         "}↳ {truncate(factor.evidence, 60)}
        </Text>
      ) : null}
    </Box>
  );
}

function HotkeyRow(): JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        {" "}
        [
        <Text color={theme.accent.primary} bold>
          a
        </Text>
        ]llow once [
        <Text color={theme.accent.primary} bold>
          d
        </Text>
        ]eny [
        <Text color={theme.accent.primary} bold>
          i
        </Text>
        ]nspect
      </Text>
      <Text>
        {" "}
        [
        <Text color={theme.accent.primary} bold>
          A
        </Text>
        ]lways allow [
        <Text color={theme.accent.primary} bold>
          D
        </Text>
        ]eny always
      </Text>
    </Box>
  );
}

function TimerLabel({
  remainingSeconds,
}: {
  remainingSeconds: number;
}): JSX.Element {
  const color =
    remainingSeconds <= 10
      ? theme.accent.danger
      : remainingSeconds <= 30
        ? theme.accent.warning
        : theme.fg.muted;
  return (
    <Text color={color}>
      {theme.symbols.timer} {remainingSeconds}s left
    </Text>
  );
}

function renderArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return JSON.stringify(args);
  const obj = args as Record<string, unknown>;
  if (typeof obj.path === "string") return `"${obj.path}"`;
  if (typeof obj.text === "string") {
    const text = obj.text as string;
    return text.length > 32 ? `"${text.slice(0, 31)}…"` : `"${text}"`;
  }
  return JSON.stringify(obj);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
