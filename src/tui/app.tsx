import { Box, useApp, useInput, useStdin } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
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

const APPROVAL_TIMEOUT_MS = 60_000;

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
  const { bus } = useDashboardServices();
  const [quitConfirm, setQuitConfirm] = useState(false);
  const [pendingApproval, setPendingApproval] =
    useState<ApprovalRequest | null>(null);
  const [approvalDeadline, setApprovalDeadline] = useState<number | null>(null);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [inspectOffset, setInspectOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
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

  return (
    <Box flexDirection="column">
      {isRawModeSupported && (
        <KeyboardHandler
          quitConfirm={quitConfirm}
          setQuitConfirm={setQuitConfirm}
          pendingApproval={pendingApproval}
          inspectOpen={inspectOpen}
          setInspectOpen={setInspectOpen}
          inspectOffset={inspectOffset}
          setInspectOffset={setInspectOffset}
          onResolveApproval={resolveApproval}
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
      ) : (
        <Box flexGrow={1}>{renderPanels(layout)}</Box>
      )}
      <StatusBar quitConfirm={quitConfirm} />
    </Box>
  );
}

interface KeyboardHandlerProps {
  quitConfirm: boolean;
  setQuitConfirm: (v: boolean) => void;
  pendingApproval: ApprovalRequest | null;
  inspectOpen: boolean;
  setInspectOpen: (v: boolean) => void;
  inspectOffset: number;
  setInspectOffset: (next: number) => void;
  onResolveApproval: (r: ApprovalResolution, by: ResolvedBy) => void;
}

function KeyboardHandler({
  quitConfirm,
  setQuitConfirm,
  pendingApproval,
  inspectOpen,
  setInspectOpen,
  inspectOffset,
  setInspectOffset,
  onResolveApproval,
}: KeyboardHandlerProps): null {
  const { exit } = useApp();
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
    if (quitConfirm) {
      if (input === "y" || input === "Y") exit();
      else if (input === "n" || input === "N" || key.escape)
        setQuitConfirm(false);
      return;
    }
    if (input === "q") exit();
    else if (key.ctrl && input === "c") setQuitConfirm(true);
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
