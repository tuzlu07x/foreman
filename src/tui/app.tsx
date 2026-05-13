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

const APPROVAL_TIMEOUT_MS = 60_000;

export type Page = "dashboard" | "logs";

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
  const { bus, mediator, sqlite } = useDashboardServices();

  const [page, setPage] = useState<Page>("dashboard");
  const [quitConfirm, setQuitConfirm] = useState(false);

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

  return (
    <Box flexDirection="column">
      {isRawModeSupported && (
        <KeyboardHandler
          page={page}
          setPage={setPage}
          quitConfirm={quitConfirm}
          setQuitConfirm={setQuitConfirm}
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
        />
      )}
      <BootBanner info={bootInfo} />
      {pendingApproval ? (
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
}

function KeyboardHandler(props: KeyboardHandlerProps): null {
  const { exit } = useApp();
  const {
    page,
    setPage,
    quitConfirm,
    setQuitConfirm,
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
  } = props;

  useInput((input, key) => {
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
      else if (input === "d")
        onResolveApproval({ decision: "denied" }, "user");
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
    if (quitConfirm) {
      if (input === "y" || input === "Y") exit();
      else if (input === "n" || input === "N" || key.escape)
        setQuitConfirm(false);
      return;
    }
    if (input === "q") exit();
    else if (key.ctrl && input === "c") setQuitConfirm(true);
    else if (input === "l") setPage("logs");
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
