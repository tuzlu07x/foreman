import { Box, useApp, useInput, useStdin } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalRequest } from "../core/approval.js";
import type { BootInfo } from "./boot-info.js";
import {
  ApprovalModal,
  type ApprovalResolution,
  type ResolvedBy,
} from "./components/approval-modal.js";
import { ActivityFeed } from "./components/activity-feed.js";
import { AgentList } from "./components/agent-list.js";
import { BootBanner } from "./components/boot-banner.js";
import { HelpOverlay } from "./components/help-overlay.js";
import { InspectView } from "./components/inspect-view.js";
import { StatsPanel } from "./components/stats-panel.js";
import { StatusBar } from "./components/status-bar.js";
import {
  DashboardProvider,
  useDashboardServices,
  type DashboardServices,
} from "./dashboard-context.js";
import { useLayout } from "./hooks.js";
import { exportLogs, LogsPage } from "./pages/logs-page.js";
import {
  DEFAULT_FILTERS,
  queryLogs,
  type LogFilters,
} from "./pages/logs-query.js";
import {
  ChatPage,
  parseChatPrompt,
  type ChatScrollbackEntry,
} from "./pages/chat-page.js";
import { PolicyPage } from "./pages/policy-page.js";
import {
  REVEAL_AUTO_HIDE_MS,
  SecretsPage,
} from "./pages/secrets-page.js";
import { AgentsPage } from "./pages/agents-page.js";
import { ProvidersPage } from "./pages/providers-page.js";
import { ServicesPage } from "./pages/services-page.js";
import { SessionsPage } from "./pages/sessions-page.js";
import { buildSettingsItems, SettingsPage } from "./pages/settings-page.js";
import { launchEditor } from "./launch-editor.js";

const APPROVAL_TIMEOUT_MS = 60_000;

export type Page =
  | "dashboard"
  | "logs"
  | "policy"
  | "sessions"
  | "agents"
  | "providers"
  | "services"
  | "secrets"
  | "settings"
  | "chat";

export interface AppProps {
  bootInfo: BootInfo;
  services: DashboardServices;
}

export function App({ bootInfo, services }: AppProps): JSX.Element {
  return (
    <DashboardProvider {...services}>
      <Shell bootInfo={bootInfo} />
    </DashboardProvider>
  );
}

function Shell({ bootInfo }: { bootInfo: BootInfo }): JSX.Element {
  const layout = useLayout();
  const { isRawModeSupported } = useStdin();
  const {
    bus,
    mediator,
    sqlite,
    policy,
    policyPath,
    sessionManager,
    soulPath,
    secretStore,
    registry,
  } = useDashboardServices();

  const [page, setPage] = useState<Page>("dashboard");
  const [quitConfirm, setQuitConfirm] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [updateNotice, setUpdateNotice] = useState<{
    current: string;
    latest: string;
  } | null>(null);
  const [agentUpdates, setAgentUpdates] = useState<
    Array<{ id: string; displayName: string; current: string; latest: string }>
  >([]);
  const [agentOvershoots, setAgentOvershoots] = useState<
    Array<{
      id: string;
      displayName: string;
      installed: string;
      supportedRange: string;
    }>
  >([]);

  useEffect(() => {
    const offUpdate = bus.on("update:available", (e) => {
      setUpdateNotice({ current: e.current, latest: e.latest });
    });
    const offAgentUpdate = bus.on("agent-update:available", (e) => {
      setAgentUpdates(e.updates);
    });
    const offAgentOvershoot = bus.on("agent-update:overshoot", (e) => {
      setAgentOvershoots(e.warnings);
    });
    return () => {
      offUpdate();
      offAgentUpdate();
      offAgentOvershoot();
    };
  }, [bus]);

  const [policySelectedIdx, setPolicySelectedIdx] = useState(0);
  const [policyExpanded, setPolicyExpanded] = useState(false);
  const [policyNotice, setPolicyNotice] = useState<string | null>(null);

  const [sessionSelectedIdx, setSessionSelectedIdx] = useState(0);
  const [sessionExpanded, setSessionExpanded] = useState(false);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  const [chatAgentIdx, setChatAgentIdx] = useState(0);
  const [chatInputMode, setChatInputMode] = useState(false);
  const [chatInputBuffer, setChatInputBuffer] = useState("");
  const [chatScrollback, setChatScrollback] = useState<ChatScrollbackEntry[]>(
    [],
  );
  const [chatNotice, setChatNotice] = useState<string | null>(null);
  const [settingsSelectedIdx, setSettingsSelectedIdx] = useState(0);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [secretsSelectedIdx, setSecretsSelectedIdx] = useState(0);
  const [secretsExpanded, setSecretsExpanded] = useState(false);
  const [secretsNotice, setSecretsNotice] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<{
    name: string;
    value: string;
  } | null>(null);
  const [rotateMode, setRotateMode] = useState<{ name: string } | null>(null);
  const [addSecretMode, setAddSecretMode] = useState<
    { phase: "name" } | { phase: "value"; name: string } | null
  >(null);
  const [agentsSelectedIdx, setAgentsSelectedIdx] = useState(0);
  const [agentsExpanded, setAgentsExpanded] = useState(false);
  const [agentsNotice, setAgentsNotice] = useState<string | null>(null);
  const [agentsEditMode, setAgentsEditMode] = useState<"none" | "note" | "llm">(
    "none",
  );
  const [agentsLlmDraft, setAgentsLlmDraft] = useState<string | null>(null);

  const [pendingApproval, setPendingApproval] =
    useState<ApprovalRequest | null>(null);
  const [approvalDeadline, setApprovalDeadline] = useState<number | null>(null);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [inspectOffset, setInspectOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const [logSearch, setLogSearch] = useState("");
  const [logSearchMode, setLogSearchMode] = useState(false);
  const [logFilters, setLogFilters] = useState<LogFilters>(DEFAULT_FILTERS);
  const [logSelectedIdx, setLogSelectedIdx] = useState(0);
  const [logExpanded, setLogExpanded] = useState(false);
  const [logExportNotice, setLogExportNotice] = useState<string | null>(null);
  const [logReplayNotice, setLogReplayNotice] = useState<string | null>(null);

  const pendingRef = useRef(pendingApproval);
  pendingRef.current = pendingApproval;

  useEffect(() => {
    return bus.on("approval:requested", (req) => {
      setPendingApproval(req);
      setApprovalDeadline(Date.now() + APPROVAL_TIMEOUT_MS);
      setInspectOpen(false);
      setInspectOffset(0);
    });
  }, [bus]);

  useEffect(() => {
    if (!pendingApproval) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [pendingApproval]);

  const resolveApproval = useCallback(
    (resolution: ApprovalResolution, resolvedBy: ResolvedBy): void => {
      const current = pendingRef.current;
      if (!current) return;
      bus.emit("approval:resolved", {
        requestId: current.requestId,
        decision: resolution.decision,
        remember: resolution.remember,
        resolvedBy,
      });
      setPendingApproval(null);
      setApprovalDeadline(null);
      setInspectOpen(false);
      setInspectOffset(0);
    },
    [bus],
  );

  useEffect(() => {
    if (!pendingApproval || approvalDeadline === null) return;
    if (now >= approvalDeadline) {
      resolveApproval({ decision: "denied" }, "timeout");
    }
  }, [now, pendingApproval, approvalDeadline, resolveApproval]);

  const onHaltSessionFromApproval = useCallback((): void => {
    const current = pendingRef.current;
    if (!current?.sessionId || !sessionManager) return;
    if (!current.riskFactors?.some((f) => f.category === "loop")) return;
    sessionManager.halt(current.sessionId, "loop_detection");
    resolveApproval({ decision: "denied" }, "user");
  }, [sessionManager, resolveApproval]);

  const remainingSeconds =
    approvalDeadline === null
      ? 0
      : Math.max(0, Math.ceil((approvalDeadline - now) / 1000));

  const selectedRequestId = useMemo(() => {
    if (page !== "logs") return null;
    const rows = queryLogs(sqlite, {
      search: logSearch,
      filters: logFilters,
      limit: 200,
    }).rows;
    return rows[logSelectedIdx]?.id ?? null;
  }, [page, sqlite, logSearch, logFilters, logSelectedIdx]);

  const onLogReplay = useCallback(async (): Promise<void> => {
    if (!mediator || !selectedRequestId) {
      setLogReplayNotice("replay unavailable");
      return;
    }
    try {
      const result = await mediator.replay(selectedRequestId);
      setLogReplayNotice(
        `replayed ${selectedRequestId} → ${result.decision} (${result.decidedBy})`,
      );
    } catch (err) {
      setLogReplayNotice(
        `replay failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [mediator, selectedRequestId]);

  const onLogExport = useCallback((): void => {
    const rows = queryLogs(sqlite, {
      search: logSearch,
      filters: logFilters,
      limit: 10_000,
    }).rows;
    const { path, count } = exportLogs(rows);
    setLogExportNotice(`exported ${count} rows → ${path}`);
  }, [sqlite, logSearch, logFilters]);

  const onPolicyToggle = useCallback((): void => {
    if (!policy) {
      setPolicyNotice("policy engine unavailable");
      return;
    }
    const rules = policy.list();
    const target = rules[policySelectedIdx];
    if (!target) return;
    try {
      policy.setEnabled(target.id, target.enabled === 0);
      setPolicyNotice(
        `rule #${target.id} ${target.enabled === 0 ? "enabled" : "disabled"}`,
      );
    } catch (err) {
      setPolicyNotice(
        `toggle failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [policy, policySelectedIdx]);

  const onPolicyEdit = useCallback(async (): Promise<void> => {
    if (!policy || !policyPath) {
      setPolicyNotice("policy yaml path unavailable");
      return;
    }
    try {
      await launchEditor(policyPath);
      const result = policy.loadFromYaml(policyPath);
      setPolicyNotice(
        `reloaded ${result.rulesAdded} rule${result.rulesAdded === 1 ? "" : "s"} from yaml`,
      );
    } catch (err) {
      setPolicyNotice(
        `editor / reload failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [policy, policyPath]);

  const onSessionHalt = useCallback((): void => {
    if (!sessionManager) {
      setSessionNotice("session manager unavailable");
      return;
    }
    const all = sessionManager.list();
    const target = all[sessionSelectedIdx];
    if (!target) return;
    if (target.status !== "active") {
      setSessionNotice(`session ${target.id} already ${target.status}`);
      return;
    }
    sessionManager.halt(target.id, "manual");
    setSessionNotice(`session ${target.id} halted`);
  }, [sessionManager, sessionSelectedIdx]);

  const onChatSubmit = useCallback(
    async (raw: string): Promise<void> => {
      if (!mediator) {
        setChatNotice("mediator unavailable");
        setChatInputMode(false);
        return;
      }
      const agents = registry.list();
      const picked = agents[chatAgentIdx];
      if (!picked) {
        setChatNotice("no registered agent to send through");
        setChatInputMode(false);
        return;
      }
      const { tool, args } = parseChatPrompt(raw);
      if (!tool) {
        setChatNotice("input parses as empty — type a tool name first");
        return;
      }
      try {
        const result = await mediator.handleRequest({
          sourceAgent: picked.id,
          targetTool: tool,
          message: {
            jsonrpc: "2.0" as const,
            id: Date.now(),
            method: "tools/call",
            params: { name: tool, arguments: args ?? {} },
          } as never,
        });
        const entry: ChatScrollbackEntry = {
          id: result.requestId,
          ts: Date.now(),
          sourceAgent: picked.id,
          rawPrompt: raw,
          parsedTool: tool,
          parsedArgs: args,
          decision: result.decision,
          decidedBy: result.decidedBy,
          riskScore: result.riskScore,
          riskReasons: result.riskReasons,
          durationMs: result.durationMs,
        };
        setChatScrollback((prev) => [...prev, entry]);
        setChatInputBuffer("");
        setChatNotice(null);
      } catch (err) {
        setChatScrollback((prev) => [
          ...prev,
          {
            id: `err-${Date.now()}`,
            ts: Date.now(),
            sourceAgent: picked.id,
            rawPrompt: raw,
            parsedTool: tool,
            parsedArgs: args,
            decision: "error" as const,
            decidedBy: "exception",
            riskScore: 0,
            riskReasons: [],
            durationMs: 0,
          },
        ]);
        setChatNotice(
          `error: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setChatInputMode(false);
      }
    },
    [mediator, registry, chatAgentIdx],
  );

  const onEditSoul = useCallback(async (): Promise<void> => {
    if (!soulPath) {
      setSettingsNotice("Foreman SOUL.md path unavailable");
      return;
    }
    try {
      await launchEditor(soulPath);
      setSettingsNotice(
        `✓ saved ${soulPath} — run 'foreman identity push' to propagate to agents`,
      );
    } catch (err) {
      setSettingsNotice(
        `editor failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [soulPath]);

  const onEditPolicyFromSettings = useCallback(async (): Promise<void> => {
    if (!policy || !policyPath) {
      setSettingsNotice("policy yaml path unavailable");
      return;
    }
    try {
      await launchEditor(policyPath);
      const result = policy.loadFromYaml(policyPath);
      setSettingsNotice(
        `✓ saved ${policyPath} — reloaded ${result.rulesAdded} rule${result.rulesAdded === 1 ? "" : "s"}`,
      );
    } catch (err) {
      setSettingsNotice(
        `editor / reload failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [policy, policyPath]);

  const onWizardInstruction = useCallback((): void => {
    setSettingsNotice(
      "press q to quit, then run: foreman setup --resume (or --reset for a clean wizard)",
    );
  }, []);
  const onSecretReveal = useCallback((): void => {
    if (!secretStore) return;
    const all = secretStore.list();
    const target = all[secretsSelectedIdx];
    if (!target) return;
    try {
      const value = secretStore.get(target.name);
      setRevealedSecret({ name: target.name, value });
      setSecretsNotice(
        `revealing ${target.name} for ${REVEAL_AUTO_HIDE_MS / 1000}s`,
      );
    } catch (err) {
      setSecretsNotice(
        `error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [secretStore, secretsSelectedIdx]);

  // Auto-hide revealed secret after the configured TTL.
  useEffect(() => {
    if (!revealedSecret) return;
    const t = setTimeout(() => {
      setRevealedSecret(null);
      setSecretsNotice("value auto-hidden");
    }, REVEAL_AUTO_HIDE_MS);
    return () => clearTimeout(t);
  }, [revealedSecret]);

  const onSecretRotate = useCallback((): void => {
    if (!secretStore) return;
    const all = secretStore.list();
    const target = all[secretsSelectedIdx];
    if (!target) return;
    setRotateMode({ name: target.name });
    setRevealedSecret(null);
  }, [secretStore, secretsSelectedIdx]);

  const onSubmitRotate = useCallback(
    (value: string): void => {
      if (!secretStore || !rotateMode) return;
      try {
        if (value.length === 0) {
          setSecretsNotice("rotate cancelled (empty input)");
        } else {
          secretStore.rotate(rotateMode.name, value);
          setSecretsNotice(`✓ ${rotateMode.name} rotated`);
        }
      } catch (err) {
        setSecretsNotice(
          `error: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setRotateMode(null);
      }
    },
    [secretStore, rotateMode],
  );

  const onSecretRemove = useCallback((): void => {
    if (!secretStore) return;
    const all = secretStore.list();
    const target = all[secretsSelectedIdx];
    if (!target) return;
    try {
      secretStore.remove(target.name);
      setSecretsNotice(`✓ ${target.name} removed`);
      setRevealedSecret(null);
      setSecretsSelectedIdx((idx) => Math.max(0, idx - 1));
    } catch (err) {
      setSecretsNotice(
        `error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [secretStore, secretsSelectedIdx]);

  const onSecretAddStart = useCallback((): void => {
    setSecretsNotice(null);
    setAddSecretMode({ phase: "name" });
  }, []);

  const onSecretAddNameSubmit = useCallback((name: string): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setAddSecretMode(null);
      setSecretsNotice("add cancelled (empty name)");
      return;
    }
    setAddSecretMode({ phase: "value", name: trimmed });
  }, []);

  const onSecretAddValueSubmit = useCallback(
    (value: string): void => {
      if (!secretStore) return;
      if (!addSecretMode || addSecretMode.phase !== "value") return;
      const name = addSecretMode.name;
      if (value.length === 0) {
        setAddSecretMode(null);
        setSecretsNotice(`add ${name} cancelled (empty value)`);
        return;
      }
      try {
        if (secretStore.exists(name)) {
          secretStore.rotate(name, value);
          setSecretsNotice(
            `✓ ${name} already existed — value rotated instead`,
          );
        } else {
          secretStore.add(name, value);
          setSecretsNotice(`✓ stored ${name}`);
        }
      } catch (err) {
        setSecretsNotice(
          `error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      setAddSecretMode(null);
    },
    [secretStore, addSecretMode],
  );
  const onAgentToggleBlock = useCallback((): void => {
    const all = registry.listAll();
    const target = all[agentsSelectedIdx];
    if (!target) return;
    try {
      if (target.status === "blocked") {
        registry.unblock(target.id);
        setAgentsNotice(`✓ ${target.id} unblocked`);
      } else {
        registry.block(target.id);
        setAgentsNotice(`✓ ${target.id} blocked`);
      }
    } catch (err) {
      setAgentsNotice(
        `error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [registry, agentsSelectedIdx]);

  const onAgentRegenKey = useCallback((): void => {
    const all = registry.listAll();
    const target = all[agentsSelectedIdx];
    if (!target) return;
    try {
      const result = registry.regenerateKey(target.id);
      const hex = result.privateKey.toString("hex");
      setAgentsNotice(
        `✓ ${target.id} new private key (shown once): ${hex.slice(0, 16)}…${hex.slice(-8)}`,
      );
    } catch (err) {
      setAgentsNotice(
        `error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [registry, agentsSelectedIdx]);

  const onAgentRemove = useCallback((): void => {
    const all = registry.listAll();
    const target = all[agentsSelectedIdx];
    if (!target) return;
    try {
      registry.remove(target.id);
      setAgentsNotice(`✓ ${target.id} removed`);
      setAgentsSelectedIdx((idx) => Math.max(0, idx - 1));
    } catch (err) {
      setAgentsNotice(
        `error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [registry, agentsSelectedIdx]);

  const onAgentDisable = useCallback((): void => {
    const all = registry.listAll();
    const target = all[agentsSelectedIdx];
    if (!target) return;
    if (target.status === "disabled") {
      setAgentsNotice(`${target.id} is already disabled`);
      return;
    }
    if (target.status === "blocked") {
      setAgentsNotice(`${target.id} is blocked — unblock first`);
      return;
    }
    try {
      registry.disable(target.id);
      setAgentsNotice(`✓ ${target.id} disabled`);
    } catch (err) {
      setAgentsNotice(
        `error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [registry, agentsSelectedIdx]);

  const onAgentEnable = useCallback((): void => {
    const all = registry.listAll();
    const target = all[agentsSelectedIdx];
    if (!target) return;
    if (target.status !== "disabled") {
      setAgentsNotice(`${target.id} is not disabled (status: ${target.status})`);
      return;
    }
    try {
      registry.enable(target.id);
      setAgentsNotice(`✓ ${target.id} enabled`);
    } catch (err) {
      setAgentsNotice(
        `error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [registry, agentsSelectedIdx]);

  const onAgentStartNoteEdit = useCallback((): void => {
    const all = registry.listAll();
    const target = all[agentsSelectedIdx];
    if (!target) return;
    setAgentsExpanded(true);
    setAgentsEditMode("note");
    setAgentsNotice(null);
  }, [registry, agentsSelectedIdx]);

  const onAgentStartLlmEdit = useCallback((): void => {
    const all = registry.listAll();
    const target = all[agentsSelectedIdx];
    if (!target) return;
    setAgentsExpanded(true);
    setAgentsLlmDraft(target.llmProvider ?? null);
    setAgentsEditMode("llm");
    setAgentsNotice(null);
  }, [registry, agentsSelectedIdx]);

  const onAgentSaveNote = useCallback(
    (value: string): void => {
      const all = registry.listAll();
      const target = all[agentsSelectedIdx];
      if (!target) return;
      try {
        const trimmed = value.length > 0 ? value : null;
        registry.setResponsibilityNote(target.id, trimmed);
        setAgentsNotice(
          trimmed
            ? `✓ ${target.id} responsibility updated`
            : `✓ ${target.id} responsibility cleared`,
        );
      } catch (err) {
        setAgentsNotice(
          `error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      setAgentsEditMode("none");
    },
    [registry, agentsSelectedIdx],
  );

  const onAgentSaveLlm = useCallback((): void => {
    const all = registry.listAll();
    const target = all[agentsSelectedIdx];
    if (!target) return;
    if (!agentsLlmDraft) {
      setAgentsEditMode("none");
      return;
    }
    try {
      registry.setLlmProvider(target.id, agentsLlmDraft);
      setAgentsNotice(`✓ ${target.id} LLM provider → ${agentsLlmDraft}`);
    } catch (err) {
      setAgentsNotice(
        `error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    setAgentsEditMode("none");
    setAgentsLlmDraft(null);
  }, [registry, agentsSelectedIdx, agentsLlmDraft]);

  const onAgentCancelEdit = useCallback((): void => {
    setAgentsEditMode("none");
    setAgentsLlmDraft(null);
  }, []);

  return (
    <Box flexDirection="column">
      {isRawModeSupported && (
        <KeyboardHandler
          page={page}
          setPage={setPage}
          quitConfirm={quitConfirm}
          setQuitConfirm={setQuitConfirm}
          helpOpen={helpOpen}
          setHelpOpen={setHelpOpen}
          pendingApproval={pendingApproval}
          inspectOpen={inspectOpen}
          setInspectOpen={setInspectOpen}
          inspectOffset={inspectOffset}
          setInspectOffset={setInspectOffset}
          onResolveApproval={resolveApproval}
          onHaltSessionFromApproval={onHaltSessionFromApproval}
          logSearch={logSearch}
          setLogSearch={setLogSearch}
          logSearchMode={logSearchMode}
          setLogSearchMode={setLogSearchMode}
          logFilters={logFilters}
          setLogFilters={setLogFilters}
          logSelectedIdx={logSelectedIdx}
          setLogSelectedIdx={setLogSelectedIdx}
          logExpanded={logExpanded}
          setLogExpanded={setLogExpanded}
          onLogReplay={onLogReplay}
          onLogExport={onLogExport}
          policySelectedIdx={policySelectedIdx}
          setPolicySelectedIdx={setPolicySelectedIdx}
          policyExpanded={policyExpanded}
          setPolicyExpanded={setPolicyExpanded}
          onPolicyToggle={onPolicyToggle}
          onPolicyEdit={onPolicyEdit}
          sessionSelectedIdx={sessionSelectedIdx}
          setSessionSelectedIdx={setSessionSelectedIdx}
          sessionExpanded={sessionExpanded}
          setSessionExpanded={setSessionExpanded}
          onSessionHalt={onSessionHalt}
          chatAgentIdx={chatAgentIdx}
          setChatAgentIdx={setChatAgentIdx}
          chatInputMode={chatInputMode}
          setChatInputMode={setChatInputMode}
          registeredAgentCount={registry.list().length}
          settingsSelectedIdx={settingsSelectedIdx}
          setSettingsSelectedIdx={setSettingsSelectedIdx}
          onEditSoul={onEditSoul}
          onEditPolicyFromSettings={onEditPolicyFromSettings}
          onWizardInstruction={onWizardInstruction}
          settingsItemCount={
            buildSettingsItems(soulPath ?? null, policyPath ?? null).length
          }
          secretsSelectedIdx={secretsSelectedIdx}
          setSecretsSelectedIdx={setSecretsSelectedIdx}
          secretsExpanded={secretsExpanded}
          setSecretsExpanded={setSecretsExpanded}
          rotateMode={rotateMode}
          setRotateMode={setRotateMode}
          addSecretMode={addSecretMode}
          setAddSecretMode={setAddSecretMode}
          onSecretReveal={onSecretReveal}
          onSecretRotate={onSecretRotate}
          onSecretRemove={onSecretRemove}
          onSecretAddStart={onSecretAddStart}
          agentsSelectedIdx={agentsSelectedIdx}
          setAgentsSelectedIdx={setAgentsSelectedIdx}
          agentsExpanded={agentsExpanded}
          setAgentsExpanded={setAgentsExpanded}
          onAgentToggleBlock={onAgentToggleBlock}
          onAgentRegenKey={onAgentRegenKey}
          onAgentRemove={onAgentRemove}
          onAgentDisable={onAgentDisable}
          onAgentEnable={onAgentEnable}
          agentsEditMode={agentsEditMode}
          onAgentStartNoteEdit={onAgentStartNoteEdit}
          onAgentStartLlmEdit={onAgentStartLlmEdit}
          onAgentSaveLlm={onAgentSaveLlm}
          onAgentCancelEdit={onAgentCancelEdit}
        />
      )}
      <BootBanner
        info={bootInfo}
        animationsEnabled={isRawModeSupported}
        updateNotice={updateNotice}
        agentUpdates={agentUpdates}
        agentOvershoots={agentOvershoots}
      />
      {helpOpen ? (
        <HelpOverlay />
      ) : pendingApproval ? (
        inspectOpen ? (
          <InspectView
            request={pendingApproval}
            offset={inspectOffset}
            setOffset={setInspectOffset}
            remainingSeconds={remainingSeconds}
          />
        ) : (
          <ApprovalModal
            request={pendingApproval}
            remainingSeconds={remainingSeconds}
          />
        )
      ) : page === "logs" ? (
        <LogsPage
          search={logSearch}
          searchMode={logSearchMode}
          filters={logFilters}
          selectedIdx={logSelectedIdx}
          expanded={logExpanded}
          exportNotice={logExportNotice}
          replayNotice={logReplayNotice}
        />
      ) : page === "policy" ? (
        <PolicyPage
          selectedIdx={policySelectedIdx}
          expanded={policyExpanded}
          notice={policyNotice}
        />
      ) : page === "sessions" ? (
        <SessionsPage
          selectedIdx={sessionSelectedIdx}
          expanded={sessionExpanded}
          notice={sessionNotice}
        />
      ) : page === "chat" ? (
        <ChatPage
          selectedAgentIdx={chatAgentIdx}
          inputMode={chatInputMode}
          inputBuffer={chatInputBuffer}
          setInputBuffer={setChatInputBuffer}
          scrollback={chatScrollback}
          onSubmit={(raw) => void onChatSubmit(raw)}
          notice={chatNotice}
        />
      ) : page === "settings" ? (
        <SettingsPage
          selectedIdx={settingsSelectedIdx}
          notice={settingsNotice}
        />
      ) : page === "secrets" ? (
        <SecretsPage
          selectedIdx={secretsSelectedIdx}
          expanded={secretsExpanded}
          notice={secretsNotice}
          revealedName={revealedSecret?.name ?? null}
          revealedValue={revealedSecret?.value ?? null}
          rotateMode={rotateMode}
          onSubmitRotate={onSubmitRotate}
          addSecretMode={addSecretMode}
          onAddSecretNameSubmit={onSecretAddNameSubmit}
          onAddSecretValueSubmit={onSecretAddValueSubmit}
        />
      ) : page === "agents" ? (
        <AgentsPage
          selectedIdx={agentsSelectedIdx}
          expanded={agentsExpanded}
          notice={agentsNotice}
          editMode={agentsEditMode}
          llmDraft={agentsLlmDraft}
          onLlmDraftChange={setAgentsLlmDraft}
          onNoteSubmit={onAgentSaveNote}
        />
      ) : page === "providers" ? (
        <ProvidersPage onLeave={() => setPage("dashboard")} />
      ) : page === "services" ? (
        <ServicesPage onLeave={() => setPage("dashboard")} />
      ) : (
        <Box flexGrow={1}>{renderPanels(layout)}</Box>
      )}
      <StatusBar quitConfirm={quitConfirm} />
    </Box>
  );
}

interface KeyboardHandlerProps {
  page: Page;
  setPage: (p: Page) => void;
  quitConfirm: boolean;
  setQuitConfirm: (v: boolean) => void;
  helpOpen: boolean;
  setHelpOpen: (v: boolean) => void;
  pendingApproval: ApprovalRequest | null;
  inspectOpen: boolean;
  setInspectOpen: (v: boolean) => void;
  inspectOffset: number;
  setInspectOffset: (next: number) => void;
  onResolveApproval: (r: ApprovalResolution, by: ResolvedBy) => void;
  onHaltSessionFromApproval: () => void;
  logSearch: string;
  setLogSearch: (next: string) => void;
  logSearchMode: boolean;
  setLogSearchMode: (v: boolean) => void;
  logFilters: LogFilters;
  setLogFilters: (next: LogFilters) => void;
  logSelectedIdx: number;
  setLogSelectedIdx: (next: number) => void;
  logExpanded: boolean;
  setLogExpanded: (v: boolean) => void;
  onLogReplay: () => Promise<void>;
  onLogExport: () => void;
  policySelectedIdx: number;
  setPolicySelectedIdx: (next: number) => void;
  policyExpanded: boolean;
  setPolicyExpanded: (v: boolean) => void;
  onPolicyToggle: () => void;
  onPolicyEdit: () => Promise<void>;
  sessionSelectedIdx: number;
  setSessionSelectedIdx: (next: number) => void;
  sessionExpanded: boolean;
  setSessionExpanded: (v: boolean) => void;
  onSessionHalt: () => void;
  chatAgentIdx: number;
  setChatAgentIdx: (next: number | ((prev: number) => number)) => void;
  chatInputMode: boolean;
  setChatInputMode: (v: boolean) => void;
  registeredAgentCount: number;
  settingsSelectedIdx: number;
  setSettingsSelectedIdx: (next: number) => void;
  settingsItemCount: number;
  onEditSoul: () => Promise<void>;
  onEditPolicyFromSettings: () => Promise<void>;
  onWizardInstruction: () => void;
  secretsSelectedIdx: number;
  setSecretsSelectedIdx: (next: number | ((prev: number) => number)) => void;
  secretsExpanded: boolean;
  setSecretsExpanded: (v: boolean) => void;
  rotateMode: { name: string } | null;
  setRotateMode: (next: { name: string } | null) => void;
  addSecretMode:
    | { phase: "name" }
    | { phase: "value"; name: string }
    | null;
  setAddSecretMode: (
    next: { phase: "name" } | { phase: "value"; name: string } | null,
  ) => void;
  onSecretReveal: () => void;
  onSecretRotate: () => void;
  onSecretRemove: () => void;
  onSecretAddStart: () => void;
  agentsSelectedIdx: number;
  setAgentsSelectedIdx: (next: number | ((prev: number) => number)) => void;
  agentsExpanded: boolean;
  setAgentsExpanded: (v: boolean) => void;
  onAgentToggleBlock: () => void;
  onAgentRegenKey: () => void;
  onAgentRemove: () => void;
  onAgentDisable: () => void;
  onAgentEnable: () => void;
  agentsEditMode: "none" | "note" | "llm";
  onAgentStartNoteEdit: () => void;
  onAgentStartLlmEdit: () => void;
  onAgentSaveLlm: () => void;
  onAgentCancelEdit: () => void;
}

function KeyboardHandler(props: KeyboardHandlerProps): null {
  const { exit } = useApp();
  const {
    page,
    setPage,
    quitConfirm,
    setQuitConfirm,
    helpOpen,
    setHelpOpen,
    pendingApproval,
    inspectOpen,
    setInspectOpen,
    inspectOffset,
    setInspectOffset,
    onResolveApproval,
    onHaltSessionFromApproval,
    logSearch,
    setLogSearch,
    logSearchMode,
    setLogSearchMode,
    logFilters,
    setLogFilters,
    logSelectedIdx,
    setLogSelectedIdx,
    logExpanded,
    setLogExpanded,
    onLogReplay,
    onLogExport,
    policySelectedIdx,
    setPolicySelectedIdx,
    policyExpanded,
    setPolicyExpanded,
    onPolicyToggle,
    onPolicyEdit,
    sessionSelectedIdx,
    setSessionSelectedIdx,
    sessionExpanded,
    setSessionExpanded,
    onSessionHalt,
    chatAgentIdx,
    setChatAgentIdx,
    chatInputMode,
    setChatInputMode,
    registeredAgentCount,
    settingsSelectedIdx,
    setSettingsSelectedIdx,
    settingsItemCount,
    onEditSoul,
    onEditPolicyFromSettings,
    onWizardInstruction,
    secretsSelectedIdx,
    setSecretsSelectedIdx,
    secretsExpanded,
    setSecretsExpanded,
    rotateMode,
    setRotateMode,
    addSecretMode,
    setAddSecretMode,
    onSecretReveal,
    onSecretRotate,
    onSecretRemove,
    onSecretAddStart,
    agentsSelectedIdx,
    setAgentsSelectedIdx,
    agentsExpanded,
    setAgentsExpanded,
    onAgentToggleBlock,
    onAgentRegenKey,
    onAgentRemove,
    onAgentDisable,
    onAgentEnable,
    agentsEditMode,
    onAgentStartNoteEdit,
    onAgentStartLlmEdit,
    onAgentSaveLlm,
    onAgentCancelEdit,
  } = props;

  useInput((input, key) => {
    // Help overlay takes priority — when open, Esc / `?` / `h` close it.
    if (helpOpen) {
      if (key.escape || input === "?" || input === "h") setHelpOpen(false);
      return;
    }
    if (pendingApproval && inspectOpen) {
      if (key.escape) {
        setInspectOpen(false);
        return;
      }
      if (key.upArrow) {
        setInspectOffset(Math.max(0, inspectOffset - 1));
        return;
      }
      if (key.downArrow) {
        setInspectOffset(inspectOffset + 1);
        return;
      }
      if (key.pageUp) {
        setInspectOffset(Math.max(0, inspectOffset - 10));
        return;
      }
      if (key.pageDown) {
        setInspectOffset(inspectOffset + 10);
        return;
      }
      if (input === "a") onResolveApproval({ decision: "allowed" }, "user");
      else if (input === "d") onResolveApproval({ decision: "denied" }, "user");
      return;
    }
    if (pendingApproval) {
      if (input === "a") onResolveApproval({ decision: "allowed" }, "user");
      else if (input === "A")
        onResolveApproval({ decision: "allowed", remember: "allow" }, "user");
      else if (input === "d") onResolveApproval({ decision: "denied" }, "user");
      else if (input === "D")
        onResolveApproval({ decision: "denied", remember: "deny" }, "user");
      else if (input === "i") setInspectOpen(true);
      else if (input === "k") onHaltSessionFromApproval();
      return;
    }
    if (page === "logs") {
      if (logSearchMode) {
        if (key.escape) {
          setLogSearchMode(false);
          setLogSearch("");
          return;
        }
        if (key.return) {
          setLogSearchMode(false);
          return;
        }
        if (key.backspace || key.delete) {
          setLogSearch(logSearch.slice(0, -1));
          return;
        }
        if (input && input.length === 1) {
          setLogSearch(logSearch + input);
        }
        return;
      }
      if (key.escape) {
        setPage("dashboard");
        setLogExpanded(false);
        return;
      }
      if (input === "/") {
        setLogSearchMode(true);
        return;
      }
      if (input === "1")
        setLogFilters({ ...logFilters, allowed: !logFilters.allowed });
      else if (input === "2")
        setLogFilters({ ...logFilters, denied: !logFilters.denied });
      else if (input === "3")
        setLogFilters({ ...logFilters, ask: !logFilters.ask });
      else if (input === "4")
        setLogFilters({ ...logFilters, errored: !logFilters.errored });
      else if (key.upArrow) {
        setLogSelectedIdx(Math.max(0, logSelectedIdx - 1));
        setLogExpanded(false);
      } else if (key.downArrow) {
        setLogSelectedIdx(logSelectedIdx + 1);
        setLogExpanded(false);
      } else if (key.return) setLogExpanded(!logExpanded);
      else if (input === "r") void onLogReplay();
      else if (input === "e") onLogExport();
      else if (input === "q") exit();
      return;
    }
    if (page === "policy") {
      if (key.escape) {
        setPage("dashboard");
        setPolicyExpanded(false);
        return;
      }
      if (key.upArrow) {
        setPolicySelectedIdx(Math.max(0, policySelectedIdx - 1));
        setPolicyExpanded(false);
      } else if (key.downArrow) {
        setPolicySelectedIdx(policySelectedIdx + 1);
        setPolicyExpanded(false);
      } else if (key.return) setPolicyExpanded(!policyExpanded);
      else if (input === "d") onPolicyToggle();
      else if (input === "e") void onPolicyEdit();
      else if (input === "q") exit();
      return;
    }
    if (page === "sessions") {
      if (key.escape) {
        setPage("dashboard");
        setSessionExpanded(false);
        return;
      }
      if (key.upArrow) {
        setSessionSelectedIdx(Math.max(0, sessionSelectedIdx - 1));
        setSessionExpanded(false);
      } else if (key.downArrow) {
        setSessionSelectedIdx(sessionSelectedIdx + 1);
        setSessionExpanded(false);
      } else if (key.return) setSessionExpanded(!sessionExpanded);
      else if (input === "k") onSessionHalt();
      else if (input === "q") exit();
      return;
    }
    if (page === "chat") {
      if (chatInputMode) {
        if (key.escape) setChatInputMode(false);
        return;
      }
      if (key.escape) {
        setPage("dashboard");
        return;
      }
      if (input === "i") {
        setChatInputMode(true);
        return;
      }
      if (key.leftArrow) {
        setChatAgentIdx((idx) => Math.max(0, idx - 1));
        return;
      }
      if (key.rightArrow) {
        setChatAgentIdx((idx) =>
          Math.min(Math.max(0, registeredAgentCount - 1), idx + 1),
        );
        return;
      }
      if (input === "q") exit();
      return;
    }
    if (page === "settings") {
      if (key.escape) {
        setPage("dashboard");
        return;
      }
      if (key.upArrow) {
        setSettingsSelectedIdx(Math.max(0, settingsSelectedIdx - 1));
        return;
      }
      if (key.downArrow) {
        setSettingsSelectedIdx(
          Math.min(settingsItemCount - 1, settingsSelectedIdx + 1),
        );
        return;
      }
      if (input === "e") void onEditSoul();
      else if (input === "p") void onEditPolicyFromSettings();
      else if (input === "P") setPage("policy");
      else if (input === "w") onWizardInstruction();
      else if (key.return) {
        if (settingsSelectedIdx === 0) void onEditSoul();
        else if (settingsSelectedIdx === 1) void onEditPolicyFromSettings();
        else if (settingsSelectedIdx === 2) setPage("policy");
        else if (settingsSelectedIdx === 3) onWizardInstruction();
      } else if (input === "q") exit();
      return;
    }
    if (page === "secrets") {
      if (addSecretMode) {
        // TextInput / PasswordInput inside the page handle Enter via their
        // own onSubmit; we only intercept Esc to cancel.
        if (key.escape) setAddSecretMode(null);
        return;
      }
      if (rotateMode) {
        if (key.escape) setRotateMode(null);
        return;
      }
      if (key.escape) {
        setPage("dashboard");
        setSecretsExpanded(false);
        return;
      }
      if (key.upArrow) {
        setSecretsSelectedIdx(Math.max(0, secretsSelectedIdx - 1));
        setSecretsExpanded(false);
      } else if (key.downArrow) {
        setSecretsSelectedIdx(secretsSelectedIdx + 1);
        setSecretsExpanded(false);
      } else if (key.return) setSecretsExpanded(!secretsExpanded);
      else if (input === "v") onSecretReveal();
      else if (input === "r") onSecretRotate();
      else if (input === "d") onSecretRemove();
      else if (input === "n") onSecretAddStart();
      else if (input === "q") exit();
      return;
    }
    if (page === "agents") {
      // While editing the responsibility note, TextInput handles Enter via
      // its own onSubmit; we only intercept Esc to cancel + restore focus.
      if (agentsEditMode === "note") {
        if (key.escape) onAgentCancelEdit();
        return;
      }
      // LLM Select has no onSubmit — Enter commits the staged draft.
      if (agentsEditMode === "llm") {
        if (key.escape) onAgentCancelEdit();
        else if (key.return) onAgentSaveLlm();
        return;
      }
      if (key.escape) {
        setPage("dashboard");
        setAgentsExpanded(false);
        return;
      }
      if (key.upArrow) {
        setAgentsSelectedIdx(Math.max(0, agentsSelectedIdx - 1));
        setAgentsExpanded(false);
      } else if (key.downArrow) {
        setAgentsSelectedIdx(agentsSelectedIdx + 1);
        setAgentsExpanded(false);
      } else if (key.return) setAgentsExpanded(!agentsExpanded);
      else if (input === "b") onAgentToggleBlock();
      else if (input === "d") onAgentDisable();
      else if (input === "e") onAgentEnable();
      else if (input === "r") onAgentRemove();
      else if (input === "R") onAgentRegenKey();
      else if (input === "N") onAgentStartNoteEdit();
      else if (input === "L") onAgentStartLlmEdit();
      else if (input === "q") exit();
      return;
    }
    // ProvidersPage / ServicesPage run their own useInput; short-circuit
    // here so a key (e.g. `s` for show-value) isn't double-handled by the
    // global dispatch (which would simultaneously try to setPage('sessions')).
    if (page === "providers" || page === "services") {
      if (input === "q") exit();
      return;
    }
    if (quitConfirm) {
      if (input === "y" || input === "Y") exit();
      else if (input === "n" || input === "N" || key.escape)
        setQuitConfirm(false);
      return;
    }
    if (input === "?" || input === "h") setHelpOpen(true);
    else if (input === "q") exit();
    else if (key.ctrl && input === "c") setQuitConfirm(true);
    else if (input === "c") setPage("chat");
    else if (input === "g") setPage("settings");
    else if (input === "k") setPage("secrets");
    else if (input === "a") setPage("agents");
    else if (input === "v") setPage("providers");
    else if (input === "V") setPage("services");
    else if (input === "l") setPage("logs");
    else if (input === "p") setPage("policy");
    else if (input === "s") setPage("sessions");
  });
  return null;
}

function renderPanels(layout: "wide" | "medium" | "narrow"): JSX.Element {
  if (layout === "wide") {
    return (
      <>
        <AgentList width="20%" />
        <ActivityFeed width="60%" />
        <StatsPanel width="20%" />
      </>
    );
  }
  if (layout === "medium") {
    return (
      <Box flexDirection="column" width="100%">
        <AgentList compact />
        <ActivityFeed />
      </Box>
    );
  }
  return <ActivityFeed minimal />;
}
