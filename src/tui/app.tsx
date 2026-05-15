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
import { SessionsPage } from "./pages/sessions-page.js";
import { launchEditor } from "./launch-editor.js";

const APPROVAL_TIMEOUT_MS = 60_000;

export type Page = "dashboard" | "logs" | "policy" | "sessions" | "chat";

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
  const { bus, mediator, sqlite, policy, policyPath, sessionManager, registry } =
    useDashboardServices();

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
  } = props;

  useInput((input, key) => {
    // Help overlay takes priority — when open, only `?`/Esc close it.
    if (helpOpen) {
      if (key.escape || input === "?") setHelpOpen(false);
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
      else if (input === "r")
        onResolveApproval({ decision: "allowed", remember: "allow" }, "user");
      else if (input === "i") setInspectOpen(true);
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
      // While typing, only Esc reaches us — TextInput owns the rest.
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
    if (quitConfirm) {
      if (input === "y" || input === "Y") exit();
      else if (input === "n" || input === "N" || key.escape)
        setQuitConfirm(false);
      return;
    }
    if (input === "?") setHelpOpen(true);
    else if (input === "q") exit();
    else if (key.ctrl && input === "c") setQuitConfirm(true);
    else if (input === "c") setPage("chat");
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
