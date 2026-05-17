import { Box, Text } from "ink";
import type { ApprovalRequest } from "../../core/approval.js";
import type {
  RiskBucket,
  RiskCategory,
  RiskFactor,
} from "../../core/risk-rules/types.js";
import type {
  ReportSource,
  SecurityReport,
} from "../../core/security-report.js";
import { explain } from "../reason-explanations.js";
import { borderForRisk, riskColor, theme } from "../theme.js";

export type ResolvedBy = "user" | "timeout";

export interface ApprovalResolution {
  decision: "allowed" | "denied";
  remember?: "allow" | "deny";
}

export interface ApprovalModalProps {
  request: ApprovalRequest;
  remainingSeconds: number;
  /** Layer 3 (technical detail) visibility — toggled with [t]. */
  technicalExpanded?: boolean;
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

const SOURCE_FOOTER: Record<ReportSource, string> = {
  llm_verified: "Smart analysis: contextual verification ran on this request.",
  llm_disabled:
    "Smart analysis is off. Run `foreman llm enable` for contextual reports.",
  llm_budget_exhausted:
    "Smart analysis paused — monthly LLM budget exhausted. Resets next cycle.",
  llm_failed_fallback:
    "Smart analysis temporarily unavailable (provider error). Heuristic-only.",
  heuristic_only:
    "Heuristic-only report. Run `foreman llm enable` for contextual analysis.",
};

function bucketColor(bucket: RiskBucket): string {
  return riskColor(bucket);
}

function severityColor(report: SecurityReport): string {
  // Map the modal's extra severities (uncertain / likely_legitimate) onto
  // the canonical RiskBucket palette so risk colors stay consistent across
  // legacy + report modal paths (#234 UX-1).
  switch (report.verdict.severity) {
    case "critical":
      return riskColor("critical");
    case "high":
    case "uncertain":
      return riskColor("high");
    case "medium":
      return riskColor("medium");
    case "likely_legitimate":
    case "low":
    default:
      return riskColor("low");
  }
}

export function ApprovalModal({
  request,
  remainingSeconds,
  technicalExpanded = false,
}: ApprovalModalProps): JSX.Element {
  // Prefer the 3-layer security report when available; fall back to the
  // legacy factor-grouped view for cross-process / pre-#232 requests.
  if (request.securityReport) {
    return (
      <ReportModal
        request={request}
        report={request.securityReport}
        remainingSeconds={remainingSeconds}
        technicalExpanded={technicalExpanded}
      />
    );
  }
  return (
    <LegacyModal request={request} remainingSeconds={remainingSeconds} />
  );
}

// =============================================================================
// 3-layer (SecurityReport) modal — #232 / C9
// =============================================================================

function ReportModal({
  request,
  report,
  remainingSeconds,
  technicalExpanded,
}: {
  request: ApprovalRequest;
  report: SecurityReport;
  remainingSeconds: number;
  technicalExpanded: boolean;
}): JSX.Element {
  const color = severityColor(report);
  // Border style now tracks severity (#234 UX-6): bold frame for critical
  // calls, double for high, single for medium/low. Reinforces the colour
  // signal so the user reads severity even when colours are dim/disabled.
  const border = borderForRisk(report.technical.bucket);
  return (
    <Box
      flexDirection="column"
      borderStyle={border}
      borderColor={color}
      paddingX={2}
      paddingY={0}
    >
      {/* Layer 1 — Verdict */}
      <VerdictHeader report={report} color={color} />

      <Box marginTop={1}>
        <Text>{report.oneLineSummary}</Text>
      </Box>

      {/* Layer 2 — Narrative */}
      <NarrativeBlock report={report} color={color} />

      {/* Layer 3 — Technical (collapsible) */}
      {technicalExpanded ? (
        <TechnicalBlock report={report} request={request} />
      ) : (
        <Box marginTop={1}>
          <Text color={theme.fg.muted}>
            Press [t] for technical detail ({report.technical.factors.length}{" "}
            factor{report.technical.factors.length === 1 ? "" : "s"}, score{" "}
            {report.technical.finalScore}/100).
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.fg.muted}>{SOURCE_FOOTER[report.source]}</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.fg.muted}>{"─".repeat(60)}</Text>
      </Box>

      <HotkeyRow
        showHalt={
          Boolean(request.sessionId) &&
          report.technical.factors.some((f) => f.category === "loop")
        }
        showTechnicalToggle
        technicalExpanded={technicalExpanded}
      />

      <Box marginTop={1} justifyContent="flex-end">
        <TimerLabel remainingSeconds={remainingSeconds} />
      </Box>
    </Box>
  );
}

function VerdictHeader({
  report,
  color,
}: {
  report: SecurityReport;
  color: string;
}): JSX.Element {
  const recommendation = report.narrative.recommendation;
  const recColor =
    recommendation === "deny"
      ? theme.accent.danger
      : recommendation === "ask"
        ? theme.accent.warning
        : theme.accent.success;
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="column">
        <Text>{"   ___"}</Text>
        <Text>
          {"  (o.o)  "}
          <Text bold color={color}>
            {report.verdict.icon} {report.verdict.label}
          </Text>
        </Text>
        <Text>{"   \\_/"}</Text>
      </Box>
      <Box flexDirection="column" alignItems="flex-end">
        <Text color={color}>
          score <Text bold>{report.technical.finalScore}</Text>/100
        </Text>
        <Text color={recColor}>foreman → {recommendation}</Text>
      </Box>
    </Box>
  );
}

function NarrativeBlock({
  report,
  color,
}: {
  report: SecurityReport;
  color: string;
}): JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.fg.muted}>What's happening:</Text>
      <Box paddingLeft={2}>
        <Text>{report.narrative.whatHappening}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.fg.muted}>Things to check:</Text>
      </Box>
      {report.narrative.thingsToCheck.map((item, i) => (
        <Text key={`check-${i}`}>
          {"    "}
          <Text color={color}>{theme.symbols.reason}</Text> {item}
        </Text>
      ))}
    </Box>
  );
}

function TechnicalBlock({
  report,
  request,
}: {
  report: SecurityReport;
  request: ApprovalRequest;
}): JSX.Element {
  const grouped = groupFactors(report.technical.factors);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.fg.muted}>Technical detail:</Text>
      <Box paddingLeft={2}>
        <Text color={theme.fg.muted}>
          heuristic {report.technical.heuristicScore}
          {report.technical.llmAdjustment !== null
            ? ` · LLM ${report.technical.llmAdjustment >= 0 ? "+" : ""}${report.technical.llmAdjustment}`
            : ""}{" "}
          → final {report.technical.finalScore}/100 ({report.technical.bucket})
        </Text>
      </Box>
      {grouped.length > 0 ? (
        grouped.map((group) => (
          <FactorGroup
            key={group.category}
            category={group.category}
            factors={group.factors}
            totalPoints={group.totalPoints}
          />
        ))
      ) : request.riskReasons.length > 0 ? (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          {request.riskReasons.map((r) => (
            <Text key={r} color={theme.fg.muted}>
              · {r}
              {explain(r) ? <Text>{`  (${explain(r)})`}</Text> : null}
            </Text>
          ))}
        </Box>
      ) : (
        <Box paddingLeft={2}>
          <Text color={theme.fg.muted}>
            No specific factors fired — policy asked for explicit approval.
          </Text>
        </Box>
      )}
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
    </Box>
  );
}

// =============================================================================
// Legacy fallback modal (no SecurityReport on request)
// =============================================================================

function LegacyModal({
  request,
  remainingSeconds,
}: {
  request: ApprovalRequest;
  remainingSeconds: number;
}): JSX.Element {
  const bucket: RiskBucket = request.riskBucket ?? "medium";
  const borderColor = bucketColor(bucket);
  const border = borderForRisk(bucket);
  const grouped = groupFactors(request.riskFactors ?? []);
  const hasFactors = grouped.length > 0;

  return (
    <Box
      flexDirection="column"
      borderStyle={border}
      borderColor={borderColor}
      paddingX={2}
      paddingY={0}
    >
      <LegacyHeader
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

      <HotkeyRow
        showHalt={
          Boolean(request.sessionId) &&
          (request.riskFactors ?? []).some((f) => f.category === "loop")
        }
      />

      <Box marginTop={1} justifyContent="flex-end">
        <TimerLabel remainingSeconds={remainingSeconds} />
      </Box>
    </Box>
  );
}

function LegacyHeader({
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

// =============================================================================
// Shared factor grouping + hotkey row
// =============================================================================

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

function HotkeyRow({
  showHalt,
  showTechnicalToggle = false,
  technicalExpanded = false,
}: {
  showHalt: boolean;
  showTechnicalToggle?: boolean;
  technicalExpanded?: boolean;
}): JSX.Element {
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
        {showTechnicalToggle ? (
          <>
            {" "}[
            <Text color={theme.accent.primary} bold>
              t
            </Text>
            ]{technicalExpanded ? "hide" : "echnical"}
          </>
        ) : null}
        {showHalt ? (
          <>
            {" "}[
            <Text color={theme.accent.danger} bold>
              k
            </Text>
            ]halt session
          </>
        ) : null}
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
