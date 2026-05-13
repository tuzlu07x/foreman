import { Box, Text } from "ink";
import type { ApprovalRequest } from "../../core/approval.js";
import { explain } from "../reason-explanations.js";
import { theme } from "../theme.js";

export type ResolvedBy = "user" | "timeout";

export interface ApprovalResolution {
  decision: "allowed" | "denied";
  remember?: "allow" | "deny";
}

export interface ApprovalModalProps {
  request: ApprovalRequest;
  remainingSeconds: number;
}

export function ApprovalModal({
  request,
  remainingSeconds,
}: ApprovalModalProps): JSX.Element {

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={theme.accent.warning}
      paddingX={2}
      paddingY={0}
    >
      <ModalHeader riskScore={request.riskScore} />
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

      {request.riskReasons.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.fg.muted}>Reasons:</Text>
          {request.riskReasons.map((r) => (
            <Text key={r}>
              {"    "}
              <Text color={theme.accent.warning}>
                {theme.symbols.reason}
              </Text>{" "}
              {r}
              {explain(r) ? (
                <Text color={theme.fg.muted}>{`  (${explain(r)})`}</Text>
              ) : null}
            </Text>
          ))}
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

function ModalHeader({ riskScore }: { riskScore: number }): JSX.Element {
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="column">
        <Text>{"   ___"}</Text>
        <Text>
          {"  (o.o)  "}
          <Text bold color={theme.accent.warning}>
            {theme.symbols.warn} Approval Required
          </Text>
        </Text>
        <Text>{"   \\_/"}</Text>
      </Box>
      <Text color={theme.accent.warning}>
        risk: <Text bold>{riskScore}</Text>
      </Text>
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
        ]eny always [
        <Text color={theme.accent.primary} bold>
          r
        </Text>
        ]emember rule
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
